import { listenForTest } from './listen';
import { createServer } from 'node:http';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli';
import {
    checkpointsCommand,
    deleteCommand,
    forkCommand,
    graphCommand,
    logsCommand,
    rerunCommand,
    resolveRespondValue,
    runCommand,
    statusCommand,
    validateCommand,
} from '../src/commands';
import { RunStore } from '../src/run-store';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    delete process.env.MINDOS_TEST_API_KEY;
});

describe('parseArgs', () => {
    it('parses --offline and other options', () => {
        expect(parseArgs(['validate', '-f', 'x.yml', '--offline'])).toMatchObject({
            command: 'validate',
            options: { file: 'x.yml', offline: true },
        });
        expect(parseArgs(['run', '--json', '--headless']).options).toMatchObject({ json: true, headless: true });
        expect(parseArgs(['run', '--params', 'input.json']).options).toMatchObject({ paramsFile: 'input.json' });
        expect(parseArgs(['run', '--connection-bindings', 'bindings.json']).options).toMatchObject({ connectionBindingsFile: 'bindings.json' });
    });

    it('parses explicit context files and opaque catalog cursors', () => {
        expect(parseArgs(['session', 'prepare', 'session-id', 'input', '--context', 'selection.json']).options)
            .toMatchObject({contextFile: 'selection.json'});
        const cursor = JSON.stringify({revision: 2, after: 'point', scope: 'a'.repeat(64)});
        expect(parseArgs(['session', 'contexts', 'session-id', 'binding-id', '--cursor', cursor, '--branch', 'main']).options)
            .toMatchObject({cursor, branch: 'main'});
        expect(() => parseArgs(['session', 'contexts', 'session-id', '--cursor'])).toThrow();
        expect(() => parseArgs(['session', 'prepare', 'session-id', '--context'])).toThrow();
    });

    it('parses --profile, --set-home and repeated --add-dir', () => {
        expect(parseArgs(['run', '--profile', '/tmp/mindos-data']).options).toMatchObject({ profile: '/tmp/mindos-data' });
        expect(parseArgs(['run', '--set-home', '/project']).options).toMatchObject({ setHome: '/project' });
        expect(parseArgs(['run', '--add-dir', '/lib:ro', '--add-dir', '/cache:rw']).options)
            .toMatchObject({ addDir: ['/lib:ro', '/cache:rw'] });
    });

    it('rejects unknown options', () => {
        expect(() => parseArgs(['run', '--bogus'])).toThrow('Unknown option');
    });

    it('parses published Flow selection and a durable submission file for Session calls', () => {
        expect(parseArgs(['session', 'send', 'session-id', '--flow', 'worker', '--params', 'params.json', '--submission-file', 'call.json']))
            .toMatchObject({command: 'session', positional: ['send', 'session-id'], options: {flow: 'worker', paramsFile: 'params.json', submissionFile: 'call.json'}});
    });
});

describe('resolveRespondValue', () => {
    it('maps approve/deny/value and requires exactly one', () => {
        expect(resolveRespondValue({ approve: true })).toBe(true);
        expect(resolveRespondValue({ deny: true })).toBe(false);
        expect(resolveRespondValue({ value: '{"a":1}' })).toEqual({ a: 1 });
        expect(resolveRespondValue({ value: 'plain' })).toBe('plain');
    });

    it('rejects zero or multiple response modes', () => {
        expect(() => resolveRespondValue({})).toThrow('exactly one');
        expect(() => resolveRespondValue({ approve: true, deny: true })).toThrow('exactly one');
        expect(() => resolveRespondValue({ approve: true, value: 'x' })).toThrow('exactly one');
    });
});

describe('validate --offline', () => {
    it('validates without API keys when --offline is set', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mindos-offline-'));
        const configPath = path.join(dir, 'mindos.yml');
        await writeFile(configPath, offlineConfig(), 'utf8');
        await expect(validateCommand({ file: configPath, offline: true })).resolves.toBe(0);
    });

    it('fails without --offline when the API key env is missing', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mindos-offline-'));
        const configPath = path.join(dir, 'mindos.yml');
        await writeFile(configPath, offlineConfig(), 'utf8');
        await expect(validateCommand({ file: configPath })).rejects.toThrow('environment variable');
    });
});

describe('graph command', () => {
    it('prints the compiled DAG without executing', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mindos-graph-'));
        const configPath = path.join(dir, 'mindos.yml');
        await writeFile(configPath, graphConfig(), 'utf8');
        const writes: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            writes.push(String(chunk));
            return true;
        });
        try {
            expect(await graphCommand({ file: configPath, offline: true, json: true })).toBe(0);
        } finally {
            spy.mockRestore();
        }
        const output = writes.join('');
        expect(output).toContain('"nodes"');
        expect(output).toContain('"edges"');
        expect(output).toContain('first');
        expect(output).toContain('second');
    });
});

describe('run lifecycle commands', () => {
    it('runs, lists status/logs, then deletes the run', async () => {
        const server = createServer((_request, response) => respondSse(response, 'done'));
        const port = await startServer(server);

        const workspace = await mkdtemp(path.join(tmpdir(), 'mindos-lifecycle-'));
        const configPath = path.join(workspace, 'mindos.yml');
        process.env.MINDOS_TEST_API_KEY = 'test-secret-value';
        await writeFile(configPath, runConfig(port), 'utf8');

        expect(await runCommand({ file: configPath, stateDir: path.join(workspace, '.mindos'), headless: true, json: true })).toBe(0);
        const stateDir = path.join(workspace, '.mindos');
        const runId = await latestRun(stateDir);

        expect(await statusCommand(runId, { stateDir, json: true })).toBe(0);
        expect(await logsCommand(runId, { stateDir, json: true })).toBe(0);
        expect(await checkpointsCommand(runId, { stateDir, json: true })).toBe(0);
        expect(await forkCommand(runId, { stateDir, json: true })).toBe(0);
        // rerun 用配置快照重跑，生成新的 run。
        expect(await rerunCommand(runId, { stateDir, headless: true, json: true })).toBe(0);
        expect(await deleteCommand(runId, { stateDir, json: true })).toBe(0);

        const store = new RunStore(stateDir);
        await expect(store.load(runId)).rejects.toThrow();
    }, 15_000);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function startServer(server: ReturnType<typeof createServer>): Promise<number> {
    servers.push(server);
    return listenForTest(server);
}

async function latestRun(stateDir: string): Promise<string> {
    const runIds = await readdir(path.join(stateDir, 'runs'));
    if (!runIds.length) throw new Error('No run directory found');
    return runIds[0];
}

function offlineConfig(): string {
    return `version: 1
name: offline
goal: Validate without a key
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://localhost
    api_key_env: MINDOS_MISSING_KEY_XYZ
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
    description: Done
    outputs:
      result: text
result:
  task: finish
  output: result
`;
}

function graphConfig(): string {
    return `version: 1
name: graph
goal: Show compiled DAG
providers:
  - id: mock
    implementation: openai-compatible
    base_url: http://localhost
    api_key_env: MINDOS_MISSING_KEY_XYZ
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
  - id: first
    agent: worker
    description: First
    outputs:
      result: text
  - id: second
    agent: worker
    description: Second
    depends_on: [first]
    inputs:
      source: \${tasks.first.outputs.result}
    outputs:
      result: text
result:
  task: second
  output: result
`;
}

function runConfig(port: number): string {
    return `version: 1
name: lifecycle
goal: Finish
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
tasks:
  - id: finish
    agent: worker
    description: Return done
    outputs:
      result: text
result:
  task: finish
  output: result
sandbox:
  mode: native
`;
}
