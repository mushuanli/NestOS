import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/scheduler-paused-host.ts', import.meta.url));
const diagnostics = new WeakMap<ChildProcess, string>();
function start(root: string, role: string) {
    const child = fork(fixture, [root, role], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr?.on('data', chunk => diagnostics.set(child, ((diagnostics.get(child) ?? '') + String(chunk)).slice(-8192)));
    return child;
}
function message(child: ChildProcess): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Host message timeout')); }, 10_000);
        const cleanup = () => { clearTimeout(timer); child.off('message', received); child.off('exit', exited); };
        const received = (value: unknown) => { cleanup(); resolve(value); };
        const exited = (code: number | null) => { cleanup(); reject(new Error(`Host exited: ${code}\n${diagnostics.get(child) ?? ''}`)); };
        child.once('message', received); child.once('exit', exited);
    });
}

it('fences delayed controls after a stopped local owner resumes behind its replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mindos-paused-owner-'));
    const owner = start(root, 'owner'); let replacement: ChildProcess | undefined;
    try {
        const ready = await message(owner);
        expect(ready.phase).toBe('ready');
        await new Promise(resolve => setTimeout(resolve, 1300));
        replacement = start(root, 'replacement');
        expect(await message(replacement)).toEqual({ phase: 'taken', epoch: 2 });
        const checked = message(owner); owner.send('check'); owner.kill('SIGCONT');
        expect(await checked).toEqual({ phase: 'checked', results: Array(8).fill('STALE_SHARED_LEASE') });
        const verified = message(replacement); replacement.send('verify');
        const state = await verified;
        expect(state).toMatchObject({ phase: 'verified', tasks: [{ id: ready.taskId, status: 'created' }] });
        expect(state.tasks).toHaveLength(1); expect(state.late).toBeUndefined();
        expect(state.tasks[0].control).toBeUndefined();
    } finally {
        for (const child of [owner, replacement]) if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
    }
});
