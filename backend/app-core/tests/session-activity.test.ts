import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {projectConversationsPath, resolveBrowserTarget} from '@itookit/app-contracts';
import {createApplicationRuntime, type ApplicationRuntime} from '../src/runtime/create-application-runtime';
import {createSessionBrowser} from '../src/session/session-browser';

let app: ApplicationRuntime | undefined, browser: Awaited<ReturnType<typeof createSessionBrowser>> | undefined;
afterEach(async () => {await browser?.dispose(); await app?.dispose(); browser = undefined; app = undefined; vi.restoreAllMocks();});
async function setup(count = 2) {
    app = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    const project = await app.projects.create('Activity'), group = await app.projects.sessionFolder(project), ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await app.projects.sessions.create(`Session ${i}`, group));
    browser = await createSessionBrowser({repository: app.sessionRepository, projects: app.projects, files: app.sessionFiles, kernel: app.kernel.kernel});
    const path = projectConversationsPath(project.path, {recent: true});
    const question = async (id: string, kind: 'approval' | 'input') => {
        await app!.sessionManager.bindSession(id);
        const session = await app!.kernel.kernel.openSession(id);
        const task = await session.submit({program: {kind: 'flow.human', version: '1'}, input: {requestId: kind, prompt: 'private', dependencies: []}});
        await expect.poll(async () => (await task.status()).task.interactions[kind]?.status).toBe('pending'); return task;
    };
    return {ids, path, question, kernel: app.kernel.kernel, nodes: () => browser!.fs.driver.getChildren(path)};
}

it('rebuilds pending state on initial navigation and updates a changed Session without rereading unaffected Sessions', async () => {
    const f = await setup(), task = await f.question(f.ids[0]!, 'input');
    const read = vi.spyOn(f.kernel, 'sessionActivity'), history = vi.spyOn(app!.sessionRepository, 'listHistory');
    const rows = await f.nodes(), pending = rows.find(row => resolveBrowserTarget(row.path).kind === 'session' && row.metadata.sessionActivity);
    expect(rows.some(row => (row.metadata.sessionActivity as any)?.pending.input === 1)).toBe(true);
    expect(pending).toBeDefined(); expect(read.mock.calls.map(([id]) => id).sort()).toEqual([...f.ids].sort());
    read.mockClear(); await browser!.invalidateNavigation!({activity: false}); await f.nodes(); expect(read).not.toHaveBeenCalled();
    await task.respond({interactionId: 'input', value: 'answer'}); await task.wait({timeoutMs: 2000});
    const updated = await f.nodes();
    expect(updated.some(row => (row.metadata.sessionActivity as any)?.pending.input === 1)).toBe(false);
    expect(new Set(read.mock.calls.map(([id]) => id))).toEqual(new Set([f.ids[0]])); expect(history).not.toHaveBeenCalled();
    read.mockClear(); await browser!.invalidateNavigation(); await f.nodes(); expect(read).toHaveBeenCalledTimes(2);
});

it('queries only visible recent rows rather than every historical Session and never refreshes for streaming content', async () => {
    const f = await setup(21), read = vi.spyOn(f.kernel, 'sessionActivity');
    const rows = await f.nodes(); expect(read).toHaveBeenCalledTimes(15);
    const visible = new Set(rows.filter(row => resolveBrowserTarget(row.path).kind === 'session').map(row => (resolveBrowserTarget(row.path) as {sessionId: string}).sessionId));
    expect(new Set(read.mock.calls.map(([id]) => id))).toEqual(visible);
    read.mockClear(); await f.nodes(); expect(read).not.toHaveBeenCalled();
});

it('exposes a retryable unknown status after a read failure and logs only safe diagnostic metadata', async () => {
    const f = await setup(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(f.kernel, 'sessionActivity').mockRejectedValueOnce(new Error('private prompt SECRET'));
    expect((await f.nodes()).some(row => (row.metadata.sessionActivity as any)?.unknown)).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET'); expect(warn).toHaveBeenCalledWith('[session-activity]', expect.objectContaining({operation: 'session.activity', stage: 'read', operationId: expect.any(String), error: 'ACTIVITY_READ_FAILED'}));
    read.mockRestore(); expect((await f.nodes()).some(row => (row.metadata.sessionActivity as any)?.unknown)).toBe(false);
});
