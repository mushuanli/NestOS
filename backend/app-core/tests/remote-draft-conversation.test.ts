import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {HarnessConversation, type HarnessClient, type HarnessProfile} from '@itookit/mindos-node-driver';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
import {draftConversation, draftHarness, remoteConversationJournal} from '../src/projects/remote-draft-conversation';

async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/'), recovery = new RemoteConversationStore(fs, 'draft');
    const session = {id: 'native', title: 'Native preview', cwd: '/', status: 'idle', updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'p', kind: 'native', workspaces: [{id: 'w'}],
        capabilities: {create: true, history: true, resume: true, interrupt: true, interactions: true, rename: true, slashCommands: true}};
    const client = {create: vi.fn(async () => ({session})), read: vi.fn(async () => ({session, turns: []})),
        commands: vi.fn(async () => [{name: 'verify', description: 'Verify', kind: 'prompt'}]),
        command: vi.fn(async () => ({turnId: 'command-turn'})), turn: vi.fn(async () => ({turnId: 'turn'})), operation: vi.fn(), close: vi.fn(async () => {}),
        rename: vi.fn(async (_profile, _session, name) => ({session: {...session, title: name}})),
        events: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []}))} as unknown as HarnessClient;
    const open = () => draftConversation(new HarnessConversation(draftHarness(client, recovery), profile, 'w', undefined, true,
        remoteConversationJournal(recovery, 'epoch', true)), recovery);
    return {manager, recovery, client, open, fs};
}

it('retains the provisional native identity and input across a rejected turn and reopening', async () => {
    const f = await fixture(); let view = f.open();
    try {
        await view.read(); vi.mocked(f.client.turn).mockRejectedValueOnce({outcome: 'not-committed', code: 'HARNESS_RPC_ERROR'});
        await expect(view.send('Keep input')).rejects.toMatchObject({outcome: 'not-committed'});
        expect(view.snapshot()).toMatchObject({sessionId: undefined, draft: 'Keep input', pending: false});
        expect(await f.recovery.load()).toMatchObject({sessionId: 'native', draft: 'Keep input'});
        await view.close(); view = f.open(); await view.read();
        expect(view.snapshot().sessionId).toBeUndefined();
        const sent = await view.send('Keep input');
        expect(sent).toMatchObject({sessionId: 'native', submittedTurnId: 'turn', draft: '', pending: false});
        expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledTimes(2);
        expect(f.client.rename).toHaveBeenCalledWith('p', 'native', expect.stringMatching(/^\d{4}/), expect.anything());
        expect((await new RemoteConversationStore(f.fs, 'draft').load())?.submittedTurnId).toBe('turn');
        await view.close(); view = f.open();
        expect(await view.read()).toMatchObject({sessionId: undefined, submittedTurnId: undefined, draft: '', pending: false});
        expect(f.client.create).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});

it('does not promote or repeat an unknown turn until its receipt confirms commitment', async () => {
    const f = await fixture(), view = f.open();
    try {
        await view.read(); vi.mocked(f.client.turn).mockRejectedValueOnce({outcome: 'unknown'});
        await expect(view.send('Only once')).rejects.toMatchObject({outcome: 'unknown'});
        expect(view.snapshot()).toMatchObject({sessionId: undefined, draft: 'Only once', pending: true});
        await expect(view.send('Only once')).rejects.toMatchObject({code: 'EBUSY'});
        vi.mocked(f.client.operation).mockResolvedValue({requestId: 'receipt', outcome: 'committed', result: {turnId: 'turn'}});
        expect(await view.reconcile()).toMatchObject({sessionId: 'native', submittedTurnId: 'turn', pending: false, draft: ''});
        expect(f.client.turn).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});

it('keeps an accepted turn distinct from an uncertain automatic title update', async () => {
    const f = await fixture(), view = f.open();
    try {
        await view.read(); vi.mocked(f.client.rename!).mockRejectedValueOnce({outcome: 'unknown'});
        const result = await view.send('Already accepted');
        expect(result).toMatchObject({sessionId: 'native', submittedTurnId: 'turn', draft: '', pending: true});
        expect(await f.recovery.load()).toMatchObject({submittedTurnId: 'turn', pending: {operation: 'rename'}});
        await expect(view.send('Already accepted')).rejects.toMatchObject({code: 'EBUSY'});
        expect(f.client.turn).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});

it.each([false, true])('promotes the first prompt command through the same durable draft journal (lost response: %s)', async lost => {
    const f = await fixture(), view = f.open();
    try {
        await view.read();
        if (lost) vi.mocked(f.client.command!).mockRejectedValueOnce({outcome: 'unknown'});
        if (lost) {
            await expect(view.command!('verify')).rejects.toMatchObject({outcome: 'unknown'});
            expect(view.snapshot().sessionId).toBeUndefined();
            vi.mocked(f.client.operation).mockResolvedValue({requestId: 'receipt', outcome: 'committed', result: {turnId: 'command-turn'}});
            await view.reconcile();
        } else await view.command!('verify');
        expect(view.snapshot()).toMatchObject({sessionId: 'native', submittedTurnId: 'command-turn', pending: false, draft: ''});
        expect((await new RemoteConversationStore(f.fs, 'draft').load())?.submittedTurnId).toBe('command-turn');
        expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.command).toHaveBeenCalledOnce();
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.rename).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});
