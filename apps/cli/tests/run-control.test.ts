// @file: apps/cli/tests/run-control.test.ts
// CLI-side closure for Run control: per-task timeout and SIGINT cancellation.
// These exercise the monitor window (`submit` must return before the graph ends) and
// the adapter-confirmed cancellation contract: a cancelled Effect is only cleaned up
// once its adapter can prove the in-flight request stopped. "Cancel requested" is not
// "process stopped", so both tests assert the client actually disconnected.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listenForTest } from './listen';
import { resumeCommand } from '../src/commands';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const CLI_CWD = fileURLToPath(new URL('../', import.meta.url));
const children: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    delete process.env.NESTOS_TEST_API_KEY;
});

/**
 * Mock model server that accepts requests and never answers. `requested` resolves when
 * the first request arrives; `disconnected` resolves when the client drops it, which is
 * the observable proof that cancellation actually stopped the in-flight call.
 */
function hangingServer() {
    let firstRequest!: () => void, disconnected!: () => void, requestCount = 0;
    const requested = new Promise<void>(resolve => { firstRequest = resolve; });
    const dropped = new Promise<void>(resolve => { disconnected = resolve; });
    const server = createServer((request, response) => {
        request.on('data', () => undefined);
        request.on('end', () => {
            requestCount += 1;
            firstRequest();
            response.on('close', () => disconnected());
            // Hold the response open; nothing is written.
        });
    });
    return { server, requested, dropped, requests: () => requestCount };
}

function config(port: number, timeout?: string): string {
    return `version: 1
name: control
goal: Control the Run
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
${timeout ? `    timeout: ${timeout}` : ''}
    outputs:
      result: text
result:
  task: finish
  output: result
sandbox:
  mode: native
`;
}

function startRun(configPath: string, stateDir: string): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'run', '-f', configPath,
        '--state-dir', stateDir, '--headless', '--json'], { cwd: CLI_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
}

async function layout(prefix: string): Promise<{ workspace: string; stateDir: string; configPath: string }> {
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(workspace);
    return { workspace, stateDir: path.join(workspace, '.nestos'), configPath: path.join(workspace, 'mindos.yml') };
}

async function latestRun(stateDir: string): Promise<string> {
    return (await readdir(path.join(stateDir, 'runs')))[0];
}

async function manifest(stateDir: string, runId: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8'));
}

it('stops a node that exceeds its configured timeout and fails the Run', async () => {
    const model = hangingServer();
    const port = await listenForTest(model.server);
    servers.push(model.server);
    const { stateDir, configPath } = await layout('nestos-timeout-');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port, '400ms'), 'utf8');

    const child = startRun(configPath, stateDir);
    const [code] = await once(child, 'exit') as [number, NodeJS.Signals | null];
    // The Kernel only reports cleanup once the adapter confirms the request stopped.
    await model.dropped;
    const saved = await manifest(stateDir, await latestRun(stateDir));
    expect(code).toBe(1);
    expect(saved).toMatchObject({ status: 'failed', taskStatuses: { finish: 'cancelled' } });
    expect(String(saved.error)).toContain('no output');
    expect(model.requests()).toBe(1);
}, 30_000);

it('cancels the Run and stops the in-flight request on SIGINT', async () => {
    const model = hangingServer();
    const port = await listenForTest(model.server);
    servers.push(model.server);
    const { stateDir, configPath } = await layout('nestos-sigint-');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port), 'utf8');

    const child = startRun(configPath, stateDir);
    await model.requested;
    child.kill('SIGINT');
    const [code] = await once(child, 'exit') as [number, NodeJS.Signals | null];
    await model.dropped;
    const runId = await latestRun(stateDir);
    const saved = await manifest(stateDir, runId);
    expect(code).toBe(130);
    expect(saved).toMatchObject({ status: 'cancelled' });
    expect(String(saved.error)).toContain('SIGINT');
    expect(saved.taskStatuses).toMatchObject({ finish: expect.stringMatching(/cancelled|failed/) });
    // A cancelled Run is terminal: resuming reports the failure and must not dispatch
    // the node again (no second model request).
    expect(await resumeCommand(runId, { stateDir, headless: true, json: true })).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(model.requests()).toBe(1);
}, 30_000);
