// @file: apps/cli/tests/run-live-owner-refusal.test.ts
// Cross-process Run control boundary: a Session has a single writer, so `nestos cancel`
// refuses a Run whose owner is still alive. The refusal must leave the Run untouched
// (the in-flight request keeps running), and only the owner can stop it (SIGINT).
// Cancelling a Run left blocked by a dead owner is covered by crash-matrix.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listenForTest } from './listen';

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

/** Accepts a request and never answers; reports arrival and client disconnect. */
function hangingServer() {
    let arrived!: () => void, dropped!: () => void, count = 0;
    const requested = new Promise<void>(resolve => { arrived = resolve; });
    const disconnected = new Promise<void>(resolve => { dropped = resolve; });
    const server = createServer((request, response) => {
        request.on('data', () => undefined);
        request.on('end', () => {
            count += 1;
            arrived();
            response.on('close', () => dropped());
        });
    });
    return { server, requested, dropped: disconnected, requests: () => count };
}

function config(port: number): string {
    return `version: 1
name: cross-cancel
goal: Cancel boundary
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
    outputs:
      result: text
result:
  task: finish
  output: result
sandbox:
  mode: native
`;
}

function spawnCli(args: string[]): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: CLI_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    child.stdout!.resume(); child.stderr!.resume();
    return child;
}

async function layout(prefix: string): Promise<{ stateDir: string; configPath: string }> {
    const workspace = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(workspace);
    return { stateDir: path.join(workspace, '.nestos'), configPath: path.join(workspace, 'mindos.yml') };
}

async function latestRun(stateDir: string): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const runs = await readdir(path.join(stateDir, 'runs'));
            if (runs.length) return runs[0];
        } catch { /* not created yet */ }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Run did not start');
}

it('refuses to cancel a Run owned by a live host and leaves it running', async () => {
    const model = hangingServer();
    const port = await listenForTest(model.server);
    servers.push(model.server);
    const { stateDir, configPath } = await layout('nestos-cross-cancel-');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port), 'utf8');

    const running = spawnCli(['run', '-f', configPath, '--state-dir', stateDir, '--headless', '--json']);
    await model.requested;
    const runId = await latestRun(stateDir);

    const cancelling = spawnCli(['cancel', runId, '--state-dir', stateDir, '--json']);
    let cancelOut = '';
    cancelling.stdout!.on('data', chunk => { cancelOut += String(chunk); });
    cancelling.stderr!.on('data', chunk => { cancelOut += String(chunk); });
    const [cancelCode] = await once(cancelling, 'close') as [number, NodeJS.Signals | null];
    // The owner holds the Session lease; the second process is refused, not silently ignored.
    expect(cancelCode).toBe(2);
    expect(cancelOut).toContain('is owned by');

    // The refusal must not disturb the Run: the request is still in flight.
    const droppedWhileRefused = await Promise.race([
        model.dropped.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(droppedWhileRefused).toBe(false);
    expect(running.exitCode).toBeNull();
    expect(running.signalCode).toBeNull();

    // Only the owning process can stop the work.
    running.kill('SIGINT');
    const [runCode] = await once(running, 'exit') as [number, NodeJS.Signals | null];
    await model.dropped;
    expect(runCode).toBe(130);
    const saved = JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ status: 'cancelled' });
    expect(model.requests()).toBe(1);
}, 60_000);
