import { parse, stringify } from 'yaml';
import { listenForTest } from './listen';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportCommand, runCommand } from '../src/commands';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    delete process.env.NESTOS_TEST_API_KEY;
});

describe('CLI run', () => {
    it('injects workspace project and automatic Skill rules into model requests', async () => {
        const { server, requests } = mockServer(() => 'done');
        const port = await startServer(server);
        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-context-'));
        await mkdir(path.join(workspace, '_agent/skills/review'), { recursive: true });
        await writeFile(path.join(workspace, '_agent/AGENT.md'), 'Project rule: verify public interfaces.');
        await writeFile(path.join(workspace, '_agent/skills/review/SKILL.md'),
            '---\nname: Review\ndescription: Review changes\n---\nSkill rule: record validation evidence.');
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, config(port));
        expect(await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true })).toBe(0);
        expect(requests).toHaveLength(1);
        const system = requests[0].messages?.filter(message => message.role === 'system').map(message => message.content).join('\n');
        expect(system).toContain('Project rule: verify public interfaces.');
        expect(system).toContain('Skill rule: record validation evidence.');
    }, 15_000);

    it.each([true, false])('enforces YAML structured output while retaining raw text (valid: %s)', async valid => {
        const raw = JSON.stringify({ title: valid ? 'report' : 7 });
        const { server } = mockServer(() => raw);
        const port = await startServer(server);
        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-schema-'));
        const configPath = path.join(workspace, 'mindos.yml');
        const value = parse(config(port));
        value.agents[0].response_format = { type: 'json_schema', json_schema: { name: 'report',
            schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } };
        value.agents[0].output_validation = { on_invalid: 'continue' };
        value.tasks[0].port_schemas = { outputs: { result: { id: 'report', version: '1' } } };
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, stringify(value));
        expect(await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true }))
            .toBe(valid ? 0 : 1);
        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: valid ? 'succeeded' : 'failed' });
        if (valid) expect(JSON.parse(await readFile(path.join(runDir(workspace, runId), 'result.json'), 'utf8'))).toEqual({ title: 'report' });
    }, 15_000);

    it('runs a durable DAG and persists its final result', async () => {
        const server = createServer((_request, response) => {
            respondSse(response, 'done');
        });
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-run-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, config(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('done');
        expect(await readFile(path.join(runDir(workspace, runId), 'config.snapshot.yml'), 'utf8'))
            .not.toContain('test-secret-value');
    }, 15_000);

    it('fails a node when its token budget is exceeded', async () => {
        const server = createServer((_request, response) => {
            respondSse(response, 'done');
        });
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-run-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, config(port, { budget: 1 }), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(1);
        expect(await readManifest(workspace, await latestRun(workspace))).toMatchObject({ status: 'failed' });
    }, 15_000);

    it('runs a RAG DAG (retrieve → rerank → answer) passing plain-text output between nodes', async () => {
        const { server, requests } = ragServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-rag-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, ragConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('ANSWER: Alice works on RAG');

        // 数据流验证：每个下游节点收到的依赖是上游的纯文本 content，而非整个
        // {message, usage, ...} 信封。这验证 dependencyOutput 按 output 取值正确。
        const rerank = requestByDescription(requests, '重排检索结果');
        expect(userContents(rerank)).toContain('docs: doc1: Alice works on RAG');

        const answer = requestByDescription(requests, '生成最终答案');
        expect(userContents(answer)).toContain('context: reranked: doc1 is most relevant');

        // 依赖注入不得携带 agent 输出信封（usage/finishReason/exchanges/message 等）。
        expect(JSON.stringify(rerank?.messages)).not.toContain('"message"');
        expect(JSON.stringify(rerank?.messages)).not.toContain('finishReason');
    }, 15_000);

    it('runs a parallel RAG fan-out/fan-in (vector+files → merge → answer)', async () => {
        const { server, requests } = ragServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-rag-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, parallelRagConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('ANSWER: Alice works on RAG');

        // 并行分支：两个检索节点独立执行（无相互依赖）。
        expect(requestByDescription(requests, '向量检索')).toBeDefined();
        expect(requestByDescription(requests, '文件检索')).toBeDefined();

        // Join：merge 节点聚合两路纯文本结果，answer 再消费 merge 的纯文本输出。
        // 多依赖被合并为一个 user 消息（\n 分隔），而非信封 JSON。
        const merge = requestByDescription(requests, '合并检索结果');
        const mergeInput = userContents(merge).join('\n');
        expect(mergeInput).toContain('vector_hits: doc1 about RAG');
        expect(mergeInput).toContain('file_hits: doc2 about agents');
        expect(mergeInput).not.toContain('"message"');

        const answer = requestByDescription(requests, '生成最终答案');
        expect(userContents(answer).join('\n')).toContain('context: merged: doc1 + doc2');
    }, 15_000);

    it('routes to the matching branch and skips the other (fan-in after route)', async () => {
        const { server, requests } = routeServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-route-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, routeConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('FINAL: SEARCH RESULT');

        // 被禁用分支（code_task）从未被调用，路由只激活 search_task。
        expect(requestByDescription(requests, '执行编码任务')).toBeUndefined();
        expect(requestByDescription(requests, '执行搜索任务')).toBeDefined();
    }, 15_000);

    it('routes with a composite condition (in + not)', async () => {
        const { server, requests } = routeConditionServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-routecond-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, routeConditionConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        // classify 输出 'lookup'，命中 in 条件，search_task 被执行。
        expect(requestByDescription(requests, '执行搜索任务')).toBeDefined();
    }, 15_000);

    it('loops back to the entry node up to max_iterations', async () => {
        const { server, requests } = loopServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-loop-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, loopConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });

        // 循环体入口与循环体各执行 3 次（max_iterations=3），退出分支从未执行。
        expect(requests.filter(r => firstUser(r).includes('循环入口'))).toHaveLength(3);
        expect(requests.filter(r => firstUser(r).includes('循环体'))).toHaveLength(3);
        expect(requests.filter(r => firstUser(r).includes('退出循环'))).toHaveLength(0);
    }, 15_000);

    it('dynamically spawns a task at runtime', async () => {
        const { server, requests } = spawnServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-spawn-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, spawnConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(requestByDescription(requests, '动态任务 A')).toBeDefined();
    }, 15_000);

    it('continues downstream when a dependency fails with on_failure: continue', async () => {
        const { server, requests } = onFailureServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-onfailure-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, onFailureConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('FINAL OK');
        // 依赖节点失败（预算超限），但下游仍被请求（continue）。
        expect(requests.filter(r => firstUser(r).includes('最终答案'))).toHaveLength(1);
    }, 15_000);

    it('runs the compensate task when a node fails (Saga rollback)', async () => {
        const { server, requests } = compensateServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-compensate-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, compensateConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(1);

        // deploy 失败（预算超限），补偿任务 rollback 被执行。
        expect(requests.filter(r => firstUser(r).includes('回滚任务'))).toHaveLength(1);
    }, 15_000);

    it('runs a multi-level reverse compensation chain (B → A)', async () => {
        const { server, requests } = compensateChainServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-saga-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, compensateChainConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(1);

        // task_c 失败，反向补偿 B 和 A（都已成功）。
        expect(requests.filter(r => firstUser(r).includes('补偿 A'))).toHaveLength(1);
        expect(requests.filter(r => firstUser(r).includes('补偿 B'))).toHaveLength(1);
    }, 15_000);

    it('supervisor dispatches workers in a loop until the final answer', async () => {
        const { server, requests } = supervisorServer();
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-supervisor-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, supervisorConfig(port), 'utf8');
        const code = await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true });
        expect(code).toBe(0);

        const runId = await latestRun(workspace);
        expect(await readManifest(workspace, runId)).toMatchObject({ status: 'succeeded' });
        expect(await readFile(path.join(runDir(workspace, runId), 'result.txt'), 'utf8')).toBe('FINAL ANSWER');
        // 两个 worker 都被派发过。
        expect(requestByDescription(requests, '研究')).toBeDefined();
        expect(requestByDescription(requests, '编码')).toBeDefined();
    }, 15_000);
});

// ── Mock LLM server ──────────────────────────────────────────────────────────

interface MockRequest {
    messages?: Array<{ role: string; content?: string }>;
}

function mockServer(respond: (description: string, request?: MockRequest) => string): { server: ReturnType<typeof createServer>; requests: MockRequest[] } {
    const requests: MockRequest[] = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            if (!body.trim()) { response.writeHead(400); response.end('Request body required'); return; }
            const parsed = JSON.parse(body) as MockRequest;
            requests.push(parsed);
            respondSse(response, respond(firstUser(parsed), parsed));
        });
    });
    return { server, requests };
}

function ragServer() { return mockServer(ragResponse); }
function routeServer() { return mockServer(routeResponse); }
function routeConditionServer() { return mockServer(routeConditionResponse); }
function loopServer() { return mockServer(loopResponse); }
function spawnServer() { return mockServer(spawnResponse); }
function onFailureServer() { return mockServer(onFailureResponse); }
function compensateServer() { return mockServer(compensateResponse); }
function compensateChainServer() { return mockServer(compensateChainResponse); }
function supervisorServer() { return mockServer(supervisorResponse); }

function respondSse(response: import('node:http').ServerResponse, content: string): void {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk(content, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk('', 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }))}\n\n`);
    response.end('data: [DONE]\n\n');
}

function chunk(content: string, finishReason: string | null, usage?: Record<string, number>) {
    return {
        id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finishReason }],
        usage,
    };
}

function firstUser(request: MockRequest): string {
    return request.messages?.find(message => message.role === 'user')?.content ?? '';
}

function requestByDescription(requests: MockRequest[], description: string): MockRequest | undefined {
    return requests.find(request => firstUser(request).includes(description));
}

function userContents(request: MockRequest | undefined): string[] {
    return (request?.messages ?? [])
        .filter(message => message.role === 'user')
        .map(message => message.content ?? '');
}

function ragResponse(description: string): string {
    if (description.includes('向量检索')) return 'doc1 about RAG';
    if (description.includes('文件检索')) return 'doc2 about agents';
    if (description.includes('检索相关文档')) return 'doc1: Alice works on RAG';
    if (description.includes('重排检索结果')) return 'reranked: doc1 is most relevant';
    if (description.includes('合并检索结果')) return 'merged: doc1 + doc2';
    if (description.includes('生成最终答案')) return 'ANSWER: Alice works on RAG';
    return 'unknown';
}

function routeResponse(description: string): string {
    if (description.includes('判断任务类型')) return 'search';
    if (description.includes('执行搜索任务')) return 'SEARCH RESULT';
    if (description.includes('执行编码任务')) return 'CODE RESULT';
    if (description.includes('生成最终答案')) return 'FINAL: SEARCH RESULT';
    return 'unknown';
}

function routeConditionResponse(description: string): string {
    if (description.includes('判断任务类型')) return 'lookup';
    if (description.includes('执行搜索任务')) return 'SEARCH RESULT';
    return 'unknown';
}

function loopResponse(description: string): string {
    if (description.includes('循环入口')) return 'A';
    if (description.includes('循环体')) return 'continue';
    if (description.includes('退出循环')) return 'EXIT';
    return 'unknown';
}

function spawnResponse(description: string): string {
    if (description.includes('动态任务 A')) return 'SPAWNED A';
    return 'unknown';
}

function onFailureResponse(description: string): string {
    if (description.includes('最终答案')) return 'FINAL OK';
    return 'should fail';
}

function compensateResponse(description: string): string {
    if (description.includes('回滚任务')) return 'ROLLED BACK';
    return 'deploying';
}

function compensateChainResponse(description: string): string {
    if (description.includes('补偿 A')) return 'COMPENSATED A';
    if (description.includes('补偿 B')) return 'COMPENSATED B';
    return 'DONE';
}

function supervisorResponse(description: string, request?: MockRequest): string {
    if (description === '研究') return 'RESEARCH RESULT';
    if (description === '编码') return 'CODE RESULT';
    // lead（supervisor）：根据已收到的 worker 结果决定下一轮。
    const allContent = (request?.messages ?? []).map(m => m.content ?? '').join('\n');
    if (allContent.includes('RESEARCH RESULT') && allContent.includes('CODE RESULT')) return 'FINAL ANSWER';
    if (allContent.includes('RESEARCH RESULT')) return 'code';
    return 'research';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function startServer(server: ReturnType<typeof createServer>): Promise<number> {
    servers.push(server);
    return listenForTest(server);
}

function runDir(workspace: string, runId: string): string {
    return path.join(workspace, '.nestos', 'runs', runId);
}

async function latestRun(workspace: string): Promise<string> {
    const runIds = await readdir(path.join(workspace, '.nestos', 'runs'));
    if (!runIds.length) throw new Error('No run directory found');
    return runIds[0];
}

async function readManifest(workspace: string, runId: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(runDir(workspace, runId), 'run.json'), 'utf8'));
}

// ── Config builders ──────────────────────────────────────────────────────────

function config(port: number, options?: { budget?: number }): string {
    return `version: 1
name: integration
goal: Finish
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: finish
    agent: worker
    description: Return done
${options?.budget !== undefined ? `    budget:
      tokens: ${options.budget}` : ''}
    outputs:
      result: text
result:
  task: finish
  output: result
sandbox:
  mode: native
`;
}

function ragConfig(port: number): string {
    return `version: 1
name: rag
goal: Answer a question using retrieval
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: retriever
    connection: default
  - id: reranker
    connection: default
  - id: answerer
    connection: default
tasks:
  - id: retrieve
    agent: retriever
    description: 检索相关文档
    outputs:
      result: text
  - id: rerank
    agent: reranker
    description: 重排检索结果
    depends_on: [retrieve]
    inputs:
      docs: \${tasks.retrieve.outputs.result}
    outputs:
      result: text
  - id: answer
    agent: answerer
    description: 生成最终答案
    depends_on: [rerank]
    inputs:
      context: \${tasks.rerank.outputs.result}
    outputs:
      result: text
result:
  task: answer
  output: result
sandbox:
  mode: native
`;
}

function parallelRagConfig(port: number): string {
    return `version: 1
name: rag-parallel
goal: Answer a question using parallel retrieval
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: retriever
    connection: default
  - id: answerer
    connection: default
tasks:
  - id: retrieve_vector
    agent: retriever
    description: 向量检索
    outputs:
      result: text
  - id: retrieve_files
    agent: retriever
    description: 文件检索
    outputs:
      result: text
  - id: merge
    agent: answerer
    description: 合并检索结果
    depends_on: [retrieve_vector, retrieve_files]
    inputs:
      vector_hits: \${tasks.retrieve_vector.outputs.result}
      file_hits: \${tasks.retrieve_files.outputs.result}
    outputs:
      result: text
  - id: answer
    agent: answerer
    description: 生成最终答案
    depends_on: [merge]
    inputs:
      context: \${tasks.merge.outputs.result}
    outputs:
      result: text
result:
  task: answer
  output: result
sandbox:
  mode: native
`;
}

function routeConfig(port: number): string {
    return `version: 1
name: route
goal: Pick a branch by classifier output
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: classify
    agent: worker
    description: 判断任务类型
    outputs:
      result: text
  - id: router
    route:
      rules:
        - when: search
          then: search_task
      default: code_task
    inputs:
      input: \${tasks.classify.outputs.result}
  - id: search_task
    agent: worker
    description: 执行搜索任务
    outputs:
      result: text
  - id: code_task
    agent: worker
    description: 执行编码任务
    outputs:
      result: text
  - id: final
    agent: worker
    description: 生成最终答案
    depends_on: [search_task, code_task]
    inputs:
      search: \${tasks.search_task.outputs.result}
      code: \${tasks.code_task.outputs.result}
    outputs:
      result: text
result:
  task: final
  output: result
sandbox:
  mode: native
`;
}

function loopConfig(port: number): string {
    return `version: 1
name: loop
goal: Iterate until the limit
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: entry
    agent: worker
    description: 循环入口
    max_iterations: 3
    outputs:
      result: text
  - id: body
    agent: worker
    description: 循环体
    depends_on: [entry]
    outputs:
      result: text
  - id: router
    route:
      rules:
        - when: continue
          then: entry
      default: exit
    depends_on: [body]
    inputs:
      input: \${tasks.body.outputs.result}
  - id: exit
    agent: worker
    description: 退出循环
    outputs:
      result: text
result:
  task: body
  output: result
sandbox:
  mode: native
`;
}

function spawnConfig(port: number): string {
    return `version: 1
name: spawn
goal: Spawn a task at runtime
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: dispatcher
    description: 派发动态任务
    spawn:
      tasks:
        - id: worker_a
          agent: worker
          description: 动态任务 A
          outputs:
            result: text
      edges:
        - from: dispatcher
          to: worker_a
    outputs:
      result: text
result:
  task: dispatcher
  output: result
sandbox:
  mode: native
`;
}

function onFailureConfig(port: number): string {
    return `version: 1
name: on-failure
goal: Continue despite a failing dependency
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: fail_task
    agent: worker
    description: 失败任务
    budget:
      tokens: 1
    outputs:
      result: text
  - id: final
    agent: worker
    description: 最终答案
    depends_on:
      - task: fail_task
        on_failure: continue
    outputs:
      result: text
result:
  task: final
  output: result
sandbox:
  mode: native
`;
}

function routeConditionConfig(port: number): string {
    return `version: 1
name: route-condition
goal: Route with a composite condition
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: classify
    agent: worker
    description: 判断任务类型
    outputs:
      result: text
  - id: router
    route:
      rules:
        - when:
            and:
              - in: [search, lookup]
              - not: code
          then: search_task
      default: code_task
    inputs:
      input: \${tasks.classify.outputs.result}
  - id: search_task
    agent: worker
    description: 执行搜索任务
    outputs:
      result: text
  - id: code_task
    agent: worker
    description: 执行编码任务
    outputs:
      result: text
result:
  task: search_task
  output: result
sandbox:
  mode: native
`;
}

function compensateConfig(port: number): string {
    return `version: 1
name: compensate
goal: Roll back on failure
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: deploy
    agent: worker
    description: 部署任务
    compensate: rollback
    budget:
      tokens: 1
    outputs:
      result: text
  - id: rollback
    agent: worker
    description: 回滚任务
    outputs:
      result: text
result:
  task: deploy
  output: result
sandbox:
  mode: native
`;
}

function compensateChainConfig(port: number): string {
    return `version: 1
name: saga
goal: Multi-level rollback
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: worker
    connection: default
tasks:
  - id: task_a
    agent: worker
    description: 任务 A
    compensate: comp_a
    outputs:
      result: text
  - id: task_b
    agent: worker
    description: 任务 B
    compensate: comp_b
    depends_on: [task_a]
    outputs:
      result: text
  - id: task_c
    agent: worker
    description: 任务 C
    depends_on: [task_b]
    budget:
      tokens: 1
    outputs:
      result: text
  - id: comp_a
    agent: worker
    description: 补偿 A
    outputs:
      result: text
  - id: comp_b
    agent: worker
    description: 补偿 B
    outputs:
      result: text
result:
  task: task_c
  output: result
sandbox:
  mode: native
`;
}

function supervisorConfig(port: number): string {
    return `version: 1
name: supervisor
goal: Coordinate workers to answer
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: NESTOS_TEST_API_KEY
    models:
      - id: mock-model
connections:
  - id: default
    provider: mock
    tiers:
      standard: mock-model
agents:
  - id: coordinator
    connection: default
  - id: worker
    connection: default
tasks:
  - id: lead
    agent: coordinator
    description: 协调研究并编码
    supervisor:
      workers: [research, code]
      max_rounds: 5
    outputs:
      result: text
  - id: research
    agent: worker
    description: 研究
    outputs:
      result: text
  - id: code
    agent: worker
    description: 编码
    outputs:
      result: text
result:
  task: lead
  output: result
sandbox:
  mode: native
`;
}

describe('CLI export', () => {
    it('writes a run transcript bundle to a real file with a byte budget', async () => {
        const server = createServer((_request, response) => respondSse(response, 'done'));
        const port = await startServer(server);
        const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-export-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, config(port), 'utf8');
        expect(await runCommand({ file: configPath, stateDir: path.join(workspace, '.nestos'), headless: true, json: true })).toBe(0);

        const runId = await latestRun(workspace);
        const target = path.join(workspace, 'export.json');
        expect(await exportCommand(runId, { stateDir: path.join(workspace, '.nestos'), json: true, out: target, maxBytes: 64 * 1024 })).toBe(0);

        const document = JSON.parse(await readFile(target, 'utf8')) as {
            run: { status: string }; maxBytes: number; nodes: Array<{ nodeId: string; transcript?: { effects: unknown[]; bytes: number } }>;
        };
        expect(document.run.status).toBe('succeeded');
        expect(document.maxBytes).toBe(64 * 1024);
        expect(document.nodes).toHaveLength(1);
        expect(document.nodes[0].nodeId).toBe('finish');
        expect(document.nodes[0].transcript?.effects.length).toBeGreaterThan(0);
        expect(document.nodes[0].transcript?.bytes).toBeLessThanOrEqual(64 * 1024);
        expect(await readFile(target, 'utf8')).not.toContain('test-secret-value');
    }, 20_000);
});
