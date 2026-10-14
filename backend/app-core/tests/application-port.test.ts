import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime, type ApplicationRuntime } from '../src/runtime/create-application-runtime';
import { ApplicationHost, LocalApplicationPort } from '../src/application';
import { SessionCommand } from '@itookit/llm-session/contracts';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function runtime(): Promise<ApplicationRuntime> {
    const result = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false });
    closes.push(() => result.dispose()); return result;
}
function client(owner: ApplicationRuntime) {
    const port = new LocalApplicationPort(owner, ['minds']); closes.push(() => port.close()); return port;
}

describe('application capability boundary', () => {
    it('reads only a directory layer, pages entries and preserves non-ASCII file contents', async () => {
        const owner = await runtime(), port = client(owner), fs = await owner.vfs.openFileSystem('/home/admin/minds');
        await fs.driver.createDirectory({ parentPath: '/', name: 'nested' });
        await fs.driver.createFile({ parentPath: '/nested', name: 'child.md', content: 'child' });
        await fs.driver.createFile({ parentPath: '/', name: 'a.md', content: '你好' });
        const open = owner.vfs.openFileSystem.bind(owner.vfs);
        const source = vi.spyOn(owner.vfs, 'openFileSystem').mockImplementation(path => path === '/home/admin/minds' ? Promise.resolve(fs) : open(path));
        const read = vi.spyOn(fs.driver, 'readContent');
        const page = await port.query('directory', { workspace: { kind: 'workspace', name: 'minds' }, path: '/', limit: 1 });
        expect(page.entries).toHaveLength(1); expect(page.nextOffset).toBe(1); expect(read).not.toHaveBeenCalled(); source.mockRestore();
        const next = await port.query('directory', { workspace: { kind: 'workspace', name: 'minds' }, path: '/', offset: 1, limit: 1 });
        expect(next.entries).toHaveLength(1); expect(next.nextOffset).toBeUndefined();
        expect((await port.query('file', { workspace: { kind: 'workspace', name: 'minds' }, path: '/a.md' })).content).toBe('你好');
        await port.command('saveFile', { workspace: { kind: 'workspace', name: 'minds' }, path: '/a.md', content: '再见' });
        expect((await port.query('file', { workspace: { kind: 'workspace', name: 'minds' }, path: '/a.md' })).content).toBe('再见');
    });
    it('rejects traversal, undeclared workspaces and internal runtime access', async () => {
        const owner = await runtime(), port = client(owner);
        await expect(port.query('directory', { workspace: { kind: 'workspace', name: 'minds' }, path: '/../etc' })).rejects.toMatchObject({ code: 'EINVAL' });
        await expect(port.query('directory', { workspace: { kind: 'workspace', name: 'agents' }, path: '/' })).rejects.toMatchObject({ code: 'EACCES' });
        await expect(port.query('directory', { workspace: { kind: 'workspace', name: 'minds' }, path: '/', limit: 0 })).rejects.toMatchObject({ code: 'EINVAL' });
        await expect(port.command('conversation', { sessionId: 'missing', name: SessionCommand.GetRuntime })).rejects.toMatchObject({ code: 'ECAPABILITY' });
        await expect(port.command('createConversation', { title: '' })).rejects.toMatchObject({ code: 'EINVAL' });
    });
    it('keeps different sessions isolated and shares one execution context for the same session', async () => {
        const owner = await runtime(), first = client(owner), second = client(owner);
        const a = (await first.command('createConversation', { title: 'A' })).sessionId;
        const b = (await second.command('createConversation', { title: 'B' })).sessionId;
        const [left, right] = await Promise.all([first.query('conversation', { sessionId: a }), second.query('conversation', { sessionId: b })]);
        expect(left.snapshot.sessionId).toBe(a); expect(right.snapshot.sessionId).toBe(b);
        const [one, two] = await Promise.all([owner.openConversation(a), owner.openConversation(a)]);
        expect(one).toBe(two);
        expect((await first.query('conversation', { sessionId: a })).manifest.title).toBe('A');
        await first.close();
        expect((await second.query('conversation', { sessionId: a })).snapshot.sessionId).toBe(a);
        expect(await owner.vfs.openFileSystem('/')).toBeDefined();
        await expect(first.query('sessions', {})).rejects.toThrow('closed');
    });
    it('isolates listener failures and removes only this client subscriptions on close', async () => {
        const owner = await runtime(), first = client(owner), second = client(owner);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), listener = vi.fn();
        first.subscribe(() => { throw new Error('view failed'); }); first.subscribe(listener);
        const other = vi.fn(); second.subscribe(other);
        await owner.sessionRepository.createSession('new');
        expect(listener).toHaveBeenCalled(); expect(other).toHaveBeenCalled(); expect(warn).toHaveBeenCalled();
        await first.close(); listener.mockClear(); other.mockClear();
        await owner.sessionRepository.createSession('later');
        expect(listener).not.toHaveBeenCalled(); expect(other).toHaveBeenCalled(); warn.mockRestore();
    });
    it('initializes one host and closes clients before its owning runtime', async () => {
        const owner = await runtime(), dispose = vi.spyOn(owner, 'dispose');
        const create = vi.fn(async () => owner), host = new ApplicationHost(create, ['minds'], 2);
        closes.push(() => host.close());
        const [first, second] = await Promise.all([host.client('first'), host.client('second')]);
        expect(create).toHaveBeenCalledOnce(); expect(first).not.toBe(second);
        await expect(host.client('third')).rejects.toMatchObject({ code: 'EBUSY' });
        await host.release('first'); expect(dispose).not.toHaveBeenCalled();
        expect(await host.client('third')).toBeDefined();
        await host.close(); expect(dispose).toHaveBeenCalledOnce();
        await expect(host.client('late')).rejects.toThrow('closed');
    });
});
