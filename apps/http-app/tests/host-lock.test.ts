import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireHostLock } from '@itookit/node-host/storage';

it.each(['SIGTERM', 'SIGKILL'] as const)('releases the OS lock after its owning process exits through %s', async signal => {
    const directory = await mkdtemp(path.join(tmpdir(), 'httpd-process-lock-'));
    const entry = new URL('../../node-host/src/storage/host-lock.ts', import.meta.url).href;
    const script = `import { acquireHostLock } from ${JSON.stringify(entry)};
        const release = await acquireHostLock(process.argv[1]);
        process.on('message', () => release()); process.send('locked');`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
    const exited = once(child, 'exit');
    try {
        await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Lock owner exited before readiness'); })]);
        await expect(acquireHostLock(directory)).rejects.toThrow('another application host');
        child.kill(signal);
        expect((await exited)[1]).toBe(signal);
        const release = await acquireHostLock(directory); release();
    } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        await rm(directory, {recursive: true, force: true});
    }
});
