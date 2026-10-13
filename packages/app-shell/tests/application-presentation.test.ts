import { expect, it, vi } from 'vitest';
import type { ApplicationPort, ApplicationEvent, ApplicationQueries } from '@itookit/app-core/application/contracts';
import { ApplicationBrowserSource } from '../src/application/browser-source';
import { ApplicationConversationControls, type ApplicationDraft } from '../src/application/conversation-controls';

type View = ApplicationQueries['conversation']['output'];
function fakePort(view?: View) {
    const listeners = new Set<(event: ApplicationEvent) => void>();
    const query = vi.fn(async (name: string) => name === 'conversation' ? structuredClone(view) : { entries: [], nextOffset: undefined });
    const command = vi.fn(async () => undefined);
    const port: ApplicationPort = { query: query as ApplicationPort['query'], command: command as ApplicationPort['command'],
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: async () => {} };
    return { port, query, command, emit: (event: ApplicationEvent) => { for (const listener of listeners) listener(event); } };
}
function conversation(): View {
    return { manifest: { id: 'session', title: 'Example', createdAt: 1, updatedAt: 1 },
        snapshot: { sessionId: 'session', sessions: [], status: 'idle', isRunning: false },
        writable: true, revision: 1, hasEarlier: false, interactions: [] } as View;
}
it('loads one directory layer and suppresses hidden browser refreshes', async () => {
    const fake = fakePort(), source = new ApplicationBrowserSource(fake.port, { kind: 'workspace', name: 'notes' });
    const refresh = vi.fn(); source.subscribe(refresh);
    await source.children(null); await source.children(null);
    expect(fake.query).toHaveBeenCalledOnce(); expect(fake.query.mock.calls[0][0]).toBe('directory');
    source.setVisible(false); fake.emit({ kind: 'invalidate', scope: 'files', revision: 1 });
    expect(refresh).not.toHaveBeenCalled(); expect(fake.query).toHaveBeenCalledOnce();
    source.setVisible(true); expect(refresh).toHaveBeenCalledOnce();
    await source.children(null); expect(fake.query).toHaveBeenCalledTimes(2);
    source.close(); fake.emit({ kind: 'invalidate', scope: 'files', revision: 2 }); expect(refresh).toHaveBeenCalledOnce();
});
it('uses events instead of idle polling and waits until a hidden conversation is visible', async () => {
    const fake = fakePort(conversation()), controls = new ApplicationConversationControls(fake.port, 'session');
    const refresh = vi.fn(); controls.subscribe(refresh); await controls.read();
    for (let index = 0; index < 5; index++) await controls.poll();
    expect(fake.query).toHaveBeenCalledOnce();
    controls.setVisible(false); fake.emit({ kind: 'invalidate', scope: 'all', revision: 0 }); await controls.poll();
    expect(fake.query).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled();
    controls.setVisible(true); expect(refresh).toHaveBeenCalledOnce(); await controls.poll();
    expect(fake.query).toHaveBeenCalledTimes(2); await controls.close();
});
it('persists an ambiguous send and reconciles its receipt after reload without sending again', async () => {
    const fake = fakePort(conversation()), values = new Map<string, ApplicationDraft>();
    const drafts = { read: (id: string) => values.get(id), write: (id: string, value: ApplicationDraft) => { values.set(id, value); } };
    const first = new ApplicationConversationControls(fake.port, 'session', drafts); await first.read();
    fake.command.mockRejectedValueOnce(new TypeError('Response lost'));
    await expect(first.send('keep this draft')).rejects.toThrow('lost');
    const pending = values.get('session'); expect(pending).toMatchObject({ text: 'keep this draft', pendingRequest: expect.any(String) });
    await first.close();
    fake.query.mockImplementation(async name => name === 'receipt' ? { id: pending!.pendingRequest!, state: 'completed' } as never : structuredClone(conversation()) as never);
    const reopened = new ApplicationConversationControls(fake.port, 'session', drafts), state = await reopened.read();
    expect(state.pending).toBe(false); expect(state.draft).toBe(''); expect(fake.command).toHaveBeenCalledOnce(); await reopened.close();
});
