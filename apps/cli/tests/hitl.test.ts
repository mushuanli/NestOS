import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenForTest } from './listen';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { respondCommand, resumeCommand, runCommand } from '../src/commands';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    delete process.env.MINDOS_TEST_API_KEY;
});

describe('HITL run → respond → resume', () => {
    it.each([{ downstream: false, process: false }, { downstream: true, process: false },
        { downstream: true, process: true, repeated: false },
        { downstream: true, process: true, repeated: true }])('pauses and resumes: %j', async mode => {
        const { downstream } = mode;
        hitlCalls = 0;
        repeatQuestion = Boolean(mode.repeated);
        const server = createServer((_request, response) => respondHitl(response));
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'mindos-hitl-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.MINDOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, hitlConfig(port, downstream), 'utf8');

        // 1) run 在 AskUserQuestion 处暂停（headless 返回退出码 3）。
        expect(mode.process ? await childCli(['run', '-f', configPath, '--state-dir', path.join(workspace, '.mindos'), '--headless', '--json'])
            : await runCommand({ file: configPath, stateDir: path.join(workspace, '.mindos'), headless: true, json: true })).toBe(3);

        const stateDir = path.join(workspace, '.mindos');
        const runId = await latestRun(stateDir);
        const manifest = await readManifest(stateDir, runId);
        expect(manifest.status).toBe('waiting');
        const rootTaskId = manifest.rootTaskId;
        const requestId = (manifest.pendingInteractions as Array<{ interactionId: string }>)[0].interactionId;

        // Reattaching without an answer must preserve the question and execution identity.
        expect(mode.process ? await childCli(['resume', runId, '--state-dir', stateDir, '--headless', '--json'])
            : await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(3);
        expect(await readManifest(stateDir, runId)).toMatchObject({
            status: 'waiting', rootTaskId, nodeTaskIds: manifest.nodeTaskIds,
            pendingInteractions: manifest.pendingInteractions,
        });
        expect(hitlCalls).toBe(1);
        const journal = await readFile(path.join(stateDir, 'runs', runId, 'events.jsonl'), 'utf8');
        expect(journal.trim().split('\n').map(line => JSON.parse(line))
            .filter(event => event.type === 'task.interaction.requested')).toHaveLength(1);

        // 2) respond 批准后，resume 继续执行到完成。
        expect(mode.process ? await childCli(['respond', runId, requestId, '--state-dir', stateDir, '--approve', '--json'])
            : await respondCommand(runId, requestId, { stateDir, approve: true, json: true })).toBe(0);
        expect(mode.process ? await childCli(['resume', runId, '--state-dir', stateDir, '--headless', '--json'])
            : await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(mode.repeated ? 3 : 0);
        if (mode.repeated) {
            const waiting = await readManifest(stateDir, runId);
            expect(waiting).toMatchObject({ status: 'waiting', rootTaskId });
            const nextId = (waiting.pendingInteractions as Array<{ interactionId: string }>)[0].interactionId;
            expect(await childCli(['respond', runId, nextId, '--state-dir', stateDir, '--approve', '--json'])).toBe(0);
            expect(await childCli(['resume', runId, '--state-dir', stateDir, '--headless', '--json'])).toBe(0);
        }

        expect(await readManifest(stateDir, runId)).toMatchObject({ status: 'succeeded', rootTaskId });
        expect(hitlCalls).toBe(mode.repeated ? 4 : downstream ? 3 : 2);
        expect(await readFile(path.join(stateDir, 'runs', runId, 'result.txt'), 'utf8')).toBe('done');
    }, 20_000);
});

// ── Mock LLM server ──────────────────────────────────────────────────────────

function respondHitl(response: import('node:http').ServerResponse): void {
    // 第一次调用返回 AskUserQuestion tool_use；后续调用返回最终文本。
    const call = hitlCalls++;
    if (call === 0 || (repeatQuestion && call === 2)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            id: 'mock', object: 'chat.completion', created: 1, model: 'mock-model',
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: `call_${call + 1}`, type: 'function',
                        function: {
                            name: 'AskUserQuestion',
                            arguments: JSON.stringify({
                                questions: [{
                                    question: '继续执行吗？',
                                    header: 'Continue',
                                    options: [
                                        { label: 'yes', description: '继续' },
                                        { label: 'no', description: '停止' },
                                    ],
                                }],
                            }),
                        },
                    }],
                },
                finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }));
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1, model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
}

let hitlCalls = 0;
let repeatQuestion = false;

async function startServer(server: ReturnType<typeof createServer>): Promise<number> {
    servers.push(server);
    return listenForTest(server);
}

async function latestRun(stateDir: string): Promise<string> {
    const runIds = await readdir(path.join(stateDir, 'runs'));
    if (!runIds.length) throw new Error('No run directory found');
    return runIds[0];
}

async function readManifest(stateDir: string, runId: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8'));
}

function hitlConfig(port: number, downstream = false): string {
    return `version: 1
name: hitl
goal: Ask then finish
workspace:
  root: .
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://127.0.0.1:${port}
    default_path: /v1/chat/completions
    api_key_env: MINDOS_TEST_API_KEY
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
    stream: false
    tools: [AskUserQuestion]
tasks:
  - id: ask
    agent: worker
    description: 询问后完成
    outputs:
      result: text
${downstream ? `  - id: after
    agent: worker
    description: Finish after the answer
    depends_on: [ask]
    outputs: {result: text}
` : ''}result:
  task: ${downstream ? 'after' : 'ask'}
  output: result
sandbox:
  mode: native
`;
}

/** Each command must exit before the next process opens the same durable state. */
async function childCli(args: string[]): Promise<number> {
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args],
            { cwd, timeout: 15_000, maxBuffer: 2_000_000 }, (error, _stdout, stderr) => {
                if (!error) return resolve(0);
                if (error.code === 3 && !error.killed) return resolve(3);
                reject(new Error(`Child CLI failed: ${error.message}\n${stderr}`));
            });
    });
}
