import { afterEach, expect, it, vi } from 'vitest';
import { FSError, MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { CommandReceipts } from '../src/application/receipts';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks(); });
async function store() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    releases.push(() => runtime.dispose());
    const files = await runtime.vfs.openFileSystem('/var/lib/application');
    return { files, receipts: new CommandReceipts(async () => files) };
}
it('deduplicates concurrent delivery and preserves the completed result across client recreation', async () => {
    const { files, receipts } = await store();
    let finish!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = receipts.execute('certificate:client', 'send-1', 'send', { text: 'hello' }, run);
    const duplicate = receipts.execute('certificate:client', 'send-1', 'send', { text: 'hello' }, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const claim = await receipts.read('certificate:client', 'send-1'); expect(claim?.state).toBe('pending');
    finish('accepted'); expect(await first).toBe('accepted'); expect(await duplicate).toBe('accepted');
    const reopened = new CommandReceipts(async () => files);
    expect(await reopened.execute('certificate:client', 'send-1', 'send', { text: 'hello' }, run)).toBe('accepted');
    expect(run).toHaveBeenCalledOnce();
    expect((await reopened.read('certificate:client', 'send-1'))?.createdAt).toBe(claim?.createdAt);
});
it('refuses unknown pending outcomes and collisions while isolating different client identities', async () => {
    const { files, receipts } = await store();
    let finish!: () => void;
    const first = receipts.execute('first', 'request', 'send', {}, () => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const restarted = new CommandReceipts(async () => files), replay = vi.fn(async () => 'duplicate');
    await expect(restarted.execute('first', 'request', 'send', {}, replay)).rejects.toMatchObject({ code: 'ECONFLICT' });
    await expect(receipts.execute('first', 'request', 'send', { changed: true }, replay)).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(replay).not.toHaveBeenCalled();
    expect(await restarted.execute('second', 'request', 'send', {}, replay)).toBe('duplicate');
    finish(); await first;
});
it('records a failed command and never executes it again on redelivery', async () => {
    const { files, receipts } = await store();
    const run = vi.fn(async () => { throw new FSError('EACCES', 'Session has another owner'); });
    await expect(receipts.execute('client', 'failure', 'send', {}, run)).rejects.toMatchObject({ code: 'EACCES' });
    await expect(new CommandReceipts(async () => files).execute('client', 'failure', 'send', {}, run)).rejects.toMatchObject({ code: 'EACCES' });
    expect(run).toHaveBeenCalledOnce();
    expect(await receipts.read('client', 'failure')).toMatchObject({ state: 'failed', error: { code: 'EACCES' } });
});
