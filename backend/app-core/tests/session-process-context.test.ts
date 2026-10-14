import { expect, it, vi } from 'vitest';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { createKernelAdaptersRuntime } from '@itookit/kernel-adapters';
import { acquireSessionProcessContext } from '../src/vfs/session-process-context';

function files() {
    const release = vi.fn(async () => {});
    return { release, acquire: vi.fn(async (id: string) => ({ cwd: `/workspace/${id}`, release,
        vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] } })) };
}

it('injects Session shells into the real Bash tool and releases processes before files', async () => {
    const source = files(), released: string[] = [];
    source.release.mockImplementation(async () => { released.push('files'); });
    const calls: unknown[] = [];
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
        fileContextForSession: id => acquireSessionProcessContext(source, id, async (sessionId, context) => ({
            nativeShell: { capabilities: { ripgrep: false, fd: false }, async exec(command, args, options) {
                calls.push({ sessionId, command, args, cwd: options?.cwd });
                expect(options?.cwd).toBe(context.cwd);
                return { stdout: `result:${sessionId}`, stderr: '', code: 0 };
            } }, release: async () => { released.push(sessionId); },
        })),
    });
    try {
        for (const id of ['one', 'two']) {
            const scope = await runtime.sessions.get(id);
            const result = await scope.toolService.invoke({ toolId: 'Bash', args: { command: 'printf ready' } });
            expect(result.success).toBe(true);
            expect(JSON.stringify(result)).toContain(`result:${id}`);
        }
        expect(calls).toHaveLength(2);
        await runtime.disposeSession('one');
        expect(released).toEqual(['one', 'files']);
    } finally { await runtime.dispose(); }
    expect(released).toEqual(['one', 'files', 'two', 'files']);
});

it('preserves file-only Web contexts when no process provider is configured', async () => {
    const source = files();
    const context = await acquireSessionProcessContext(source, 'web');
    expect(context.nativeShell).toBeUndefined();
    await context.release();
    expect(source.release).toHaveBeenCalledTimes(1);
});

it('releases acquired files when platform initialization fails', async () => {
    const source = files();
    await expect(acquireSessionProcessContext(source, 'one', async () => { throw new Error('runner unavailable'); }))
        .rejects.toThrow('runner unavailable');
    expect(source.release).toHaveBeenCalledTimes(1);
});

it('retains files on process cleanup failure and retries a shared release', async () => {
    const source = files(), stop = vi.fn().mockRejectedValueOnce(new Error('stop failed')).mockResolvedValue(undefined);
    const context = await acquireSessionProcessContext(source, 'one', async () => ({
        nativeShell: { capabilities: { ripgrep: false, fd: false }, exec: async () => ({ stdout: '', stderr: '', code: 0 }) }, release: stop,
    }));
    const results = await Promise.allSettled([context.release(), context.release()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(stop).toHaveBeenCalledTimes(1); expect(source.release).not.toHaveBeenCalled();
    await Promise.all([context.release(), context.release()]);
    expect(stop).toHaveBeenCalledTimes(2); expect(source.release).toHaveBeenCalledTimes(1);
    await context.release();
    expect(stop).toHaveBeenCalledTimes(2); expect(source.release).toHaveBeenCalledTimes(1);
});
