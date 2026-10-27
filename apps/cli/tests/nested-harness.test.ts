import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Kernel, bindCapabilities, type DurableTaskProgram } from '@itookit/durable-kernel';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createVFS } from '@itookit/vfs-core';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { createKernelAdaptersRuntime } from '@itookit/kernel-adapters';
import { listenForTest } from './listen';
import { compileSessionBashFixture, repo } from './rust-fixture';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'linux').each([false, true])('Bash starts a child DAG and preserves its result (failure: %s)', async failure => {
    const directory = await mkdtemp(`${tmpdir()}/nested-harness-`);
    const requests: string[] = [];
    const server = fixtureServer(requests, failure);
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
        fileContextForSession: async () => ({ cwd: '/workspace', release: async () => {},
            vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] },
            nativeShell: { capabilities: { ripgrep: false, fd: false }, async exec(_command, args) {
                try {
                    // The child run needs the fixture LLM on loopback, so the harness opts out of the
                    // product's deny-network policy for this test only.
                    const result = await execute(`${directory}/runner`, [repo, directory, args[1]],
                        { timeout: 35_000, env: { ...process.env, SESSION_BASH_NETWORK: 'allow' } });
                    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
                } catch (error) {
                    const result = error as { code?: unknown; stdout?: string; stderr?: string };
                    if (typeof result.code !== 'number') throw error;
                    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code };
                }
            } },
        }),
    });
    try {
        const port = await listenForTest(server);
        await execute('pnpm', ['--filter', '@itookit/cli', 'build'], { cwd: repo });
        await compileSessionBashFixture(`${directory}/runner`);
        const example = await readFile(`${repo}/apps/cli/examples/minimal-dag.yml`, 'utf8');
        await writeFile(`${directory}/child.yml`, example.replace('http://127.0.0.1:8080', `http://127.0.0.1:${port}`));
        await verifyOuterHarness(directory, runtime, failure);
        if (!failure) expect(requests).toHaveLength(2);
        else expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests[1]).toContain('first-result');
        const [runId] = await readdir(`${directory}/.nestos/runs`);
        const run = `${directory}/.nestos/runs/${runId}`;
        expect(JSON.parse(await readFile(`${run}/run.json`, 'utf8'))).toMatchObject({ status: failure ? 'failed' : 'succeeded' });
        if (failure) await expect(readFile(`${run}/result.txt`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        else expect(await readFile(`${run}/result.txt`, 'utf8')).toBe('child-result');
    } finally {
        await runtime.dispose();
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
}, 180_000);

function fixtureServer(requests: string[], failure: boolean) {
    return createServer(async (request, response) => {
        let body = '';
        for await (const part of request) body += part;
        requests.push(body);
        if (failure && requests.length > 1) {
            response.writeHead(401, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'fixture denied', type: 'authentication_error' } }));
            return;
        }
        const content = requests.length === 1 ? 'first-result' : 'child-result';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [text, finish] of [[content, null], ['', 'stop']]) {
            response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
                created: 1, model: 'test', choices: [{ index: 0,
                    delta: { role: 'assistant', content: text }, finish_reason: finish }] })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
    });
}


async function openOuter(directory: string, runtime: Awaited<ReturnType<typeof createKernelAdaptersRuntime>>) {
    const { manager } = await createVFS({ rootBackend: await openLocalFSBackend({
        rootDir: `${directory}/outer-files`, sidecarDir: `${directory}/outer-db`,
    }) });
    const fs = await manager.openFileSystem('/outer');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session' }; } });
    kernel.use(runtime.plugin);
    kernel.registerProgram(outerProgram);
    await kernel.initialize();
    return { kernel, async dispose() { kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); } };
}

async function verifyOuterHarness(directory: string, runtime: Awaited<ReturnType<typeof createKernelAdaptersRuntime>>, failure: boolean) {
    let system = await openOuter(directory, runtime);
    try {
        const session = await system.kernel.createSession({ id: 'outer', storage: { kind: 'test', locator: null } });
        const task = await session.submit({ program: outerProgram.manifest, deferStart: true,
            input: 'MINIMAL_API_KEY=fixture node /app/apps/cli/dist/cli.js run -f /workspace/child.yml --state-dir /workspace/.nestos --headless --json' });
        await bindCapabilities(task, [{ kind: 'tool', uri: 'tool://runtime', rights: ['execute'], signalKey: 'toolHandleId' }]);
        const exit = await task.wait({ timeoutMs: 35_000 });
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(JSON.stringify(exit)).toContain(failure ? '[exit 1]' : '[exit 0]');
        if (!failure) expect(JSON.stringify(exit)).toContain('child-result');
        const before = await task.status();
        expect(before.task.effects.bash.status).toBe('succeeded');
        await system.dispose();
        system = await openOuter(directory, runtime);
        const restored = await system.kernel.attachTask('outer', task.id);
        expect(await restored.wait()).toEqual(exit);
        expect((await restored.status()).task.effects.bash).toEqual(before.task.effects.bash);
    } finally { await system.dispose(); }
}

const outerProgram: DurableTaskProgram<string, string> = {
    manifest: { kind: 'test.outer-bash', version: '1' },
    init: state => ({ state, next: { type: 'wait', on: { type: 'signal' } } }),
    reduce(state, event) {
        if (event.type === 'signal') {
            const handle = (event.signal.payload as { toolHandleId: string }).toolHandleId;
            return { state, actions: [{ type: 'effect', effect: {
                id: 'bash', kind: 'tool.call', version: '1', idempotencyKey: 'child-harness', timeoutMs: 35_000,
                grants: [{ handleId: handle, right: 'execute' }],
                request: { resourceHandleId: handle, toolId: 'Bash', args: { command: state, timeout_ms: 30_000 } },
            } }], next: { type: 'wait', on: { type: 'effect', id: 'bash' } } };
        }
        if (event.type === 'effect-completed') return { state, next: { type: 'complete', output: event.result } };
        return { state, next: { type: 'fail', error: { message: JSON.stringify(event) } } };
    },
};
