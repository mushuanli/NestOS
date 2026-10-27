// @file: apps/cli/tests/run-scheduler-lease-delete.test.ts
// 删除保护的第二道守卫：本机 SQLite 锁只在本地文件系统上可靠，共享存储（NFS/S3 类）上
// 必须再看写在 Session shared 里的通用调度租约。这里用一个被 SIGKILL 的宿主留下的真实租约
// 验证两点：租约未到期时 delete 拒绝、Run 目录保留；租约到期后 delete 正常放行。
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { listenForTest } from './listen';
import { deleteCommand } from '../src/commands';
import { readRunSchedulerLease } from '../src/run-scheduler-lease';

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
    delete process.env.NESTOS_SCHEDULER_LEASE_TTL_MS;
});

/** Model server that accepts the request and never answers, so the Run stays in flight. */
function hangingServer() {
    let firstRequest!: () => void;
    const requested = new Promise<void>(resolve => { firstRequest = resolve; });
    const server = createServer(request => {
        request.on('data', () => undefined);
        request.on('end', () => { firstRequest(); });
    });
    return { server, requested };
}

function config(port: number): string {
    return `version: 1
name: lease-guard
goal: Hold the scheduler lease
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

async function startCrashedRun(ttlMs: string): Promise<{ stateDir: string; runId: string }> {
    const model = hangingServer();
    const port = await listenForTest(model.server);
    servers.push(model.server);
    const workspace = await mkdtemp(path.join(tmpdir(), 'nestos-lease-delete-'));
    roots.push(workspace);
    const stateDir = path.join(workspace, '.nestos');
    const configPath = path.join(workspace, 'mindos.yml');
    process.env.NESTOS_TEST_API_KEY = 'test-secret-value';
    await writeFile(configPath, config(port), 'utf8');

    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'run', '-f', configPath,
        '--state-dir', stateDir, '--headless', '--json'], {
        cwd: CLI_CWD,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NESTOS_SCHEDULER_LEASE_TTL_MS: ttlMs },
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    await Promise.race([model.requested, exited.then(status => { throw new Error(`Run exited before requesting: ${JSON.stringify(status)} ${stderr}`); })]);
    // The lease is written before dispatch, so the crashed host leaves it behind.
    child.kill('SIGKILL');
    await exited;
    const runId = (await readdir(path.join(stateDir, 'runs')))[0]!;
    const manifestPath = path.join(stateDir, 'runs', runId, 'run.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest.status).toBe('running');
    // Isolate the lease guard from the "still running" guard: the manifest is terminal,
    // as it would be on the host that crashed right after writing the terminal status.
    await writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'cancelled' }), 'utf8');
    return { stateDir, runId };
}

it('refuses to delete a terminal Run while a crashed host still holds its scheduler lease', async () => {
    const { stateDir, runId } = await startCrashedRun('60000');
    await expect(deleteCommand(runId, { stateDir, json: true }))
        .rejects.toThrow(/is scheduled by scheduler-\S+ until \d{4}-/);
    // Nothing was removed: the guard runs before the Run directory is deleted.
    const manifest = JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8')) as { status: string };
    expect(manifest.status).toBe('cancelled');
}, 30_000);

it('deletes the Run once the crashed host scheduler lease has expired', async () => {
    const { stateDir, runId } = await startCrashedRun('1000');
    const manifest = JSON.parse(await readFile(path.join(stateDir, 'runs', runId, 'run.json'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 1_600));
    expect(await deleteCommand(runId, { stateDir, json: true })).toBe(0);
    await expect(readFile(path.join(stateDir, 'runs', runId, 'run.json'))).rejects.toThrow();
    expect(await readRunSchedulerLease({ vfsRoot: stateDir, sessionId: manifest.sessionId, rootTaskId: manifest.rootTaskId }))
        .toMatchObject({ deleted: true, expiresAt: 0 });
}, 30_000);
