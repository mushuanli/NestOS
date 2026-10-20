import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '../src/persistence/session-repository';
import {RoundLog} from '../src/persistence/round-log';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
    const backend = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    cleanup.push(() => manager.dispose());
    const repository = new SessionRepository(await manager.openFileSystem('/'));
    await repository.init();
    const id = await repository.createSession('History');
    const write = (round: string, parent?: string) => repository.writeDocument(id, `round-${round}.json`,
        JSON.stringify({ id: round, historyParentIds: parent ? [parent] : [] }));
    await write('r0'); await write('r1', 'r0'); await write('other');
    await repository.updateManifest(id, { rootRoundId: 'r0', currentHead: 'r1', branches: { main: 'r1', other: 'other' } });
    return { repository, id, write, backend };
}

it('loads branch-owned payloads through indexed and fallback snapshots without changing logical IDs', async () => {
    const {repository, id, backend} = await fixture();
    const log = new RoundLog(repository, id);
    const round = await log.append('main', {id: 'r2', sessionId: id, historyParentIds: ['r1'],
        input: [{role: 'user', content: 'Question'}], output: [{role: 'assistant', content: 'Original'}],
        executions: [], status: 'completed', createdAt: 1, origin: 'user'});
    await log.branchAfterRound(round, 'alternative'); await log.clearAssistantInRound(round);
    const transaction = vi.spyOn(backend.records!, 'transaction');
    expect((await repository.loadView(id)).chain.rounds.at(-1)).toMatchObject({id: round, output: []});
    expect(transaction).toHaveBeenCalledTimes(1);
    await repository.updateManifest(id, {children: {}});
    expect((await repository.readHistoryChain(id)).rounds.at(-1)).toMatchObject({id: round, output: []});
    await repository.updateManifest(id, {currentBranch: 'main', currentHead: round});
    expect((await repository.loadView(id)).chain.rounds.at(-1)).toMatchObject({id: round, output: [{content: 'Original'}]});
});

it('reads one selected chain without writes, and sees later branch changes on the next snapshot', async () => {
    const { repository, id, backend } = await fixture();
    await repository.updateManifest(id, { children: { r0: ['r1'] } });
    const transaction = vi.spyOn(backend.records!, 'transaction');
    const batch = vi.spyOn(backend.records!, 'getRecordFields');
    const changed = vi.fn(); repository.subscribe(changed);
    expect(await repository.readHistoryChain(id)).toMatchObject({ chain: ['r0', 'r1'], rounds: [{ id: 'r0' }, { id: 'r1' }], branch: 'main' });
    expect(transaction).toHaveBeenCalledTimes(1);
    // The location and selected history are read in the same storage snapshot.
    expect(batch).toHaveBeenCalledTimes(2);
    expect(changed).not.toHaveBeenCalled();
    await repository.updateManifest(id, { currentHead: 'other', currentBranch: 'other' });
    expect(await repository.readHistoryChain(id)).toMatchObject({ chain: ['other'], rounds: [{ id: 'other' }], branch: 'other' });
    await repository.updateManifest(id, { currentHead: null });
    expect(await repository.readHistoryChain(id)).toMatchObject({ chain: [], rounds: [] });
});

it('bounds cycles and tolerates missing or malformed ancestor documents', async () => {
    const { repository, id, write } = await fixture();
    await write('r0', 'r1');
    expect((await repository.readHistoryChain(id)).chain).toEqual(['r0', 'r1']);
    await write('r0', 'missing');
    expect((await repository.readHistoryChain(id)).rounds.map(round => round.id)).toEqual(['r0', 'r1']);
    await repository.writeDocument(id, 'round-r0.json', 'null');
    expect((await repository.readHistoryChain(id)).rounds.map(round => round.id)).toEqual(['r1']);
});

it('loads manifest, branch drafts and settings in one fresh transaction without caching later loads', async () => {
    const { repository, id, backend } = await fixture();
    await repository.updateUIState(id, { branchDrafts: { other: { inputText: 'review draft' } } });
    await repository.saveSessionSettings(id, { temperature: 0.2 });
    const transaction = vi.spyOn(backend.records!, 'transaction');
    expect(await repository.getLoadState(id)).toMatchObject({
        manifest: { currentBranch: 'main', uiState: { branchDrafts: { other: { inputText: 'review draft' } } } },
        settings: { temperature: 0.2 },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    await repository.updateManifest(id, { currentBranch: 'other', currentHead: 'other', title: 'Changed' });
    await repository.saveSessionSettings(id, { temperature: 0.8 });
    expect(await repository.getLoadState(id)).toMatchObject({
        manifest: { title: 'Changed', currentBranch: 'other' }, settings: { temperature: 0.8 },
    });
});

it('saves UI state without touching history and suppresses unchanged writes and notifications', async () => {
    const { repository, id, backend } = await fixture();
    const get = vi.spyOn(backend.records!, 'getRecordField');
    const set = vi.spyOn(backend.records!, 'setRecordField');
    const changed = vi.fn(); repository.subscribe(changed);
    const state = { branchDrafts: { main: { inputText: 'draft' } } };
    await repository.updateUIState(id, state);
    expect(get.mock.calls.map(call => call[1]).filter(field => field !== '__vfs_seq__:navigation-version')).toEqual(['__vfs_seq__:session']);
    expect(set.mock.calls.map(call => call[1]).filter(field => !field.startsWith('__vfs_seq__:navigation'))).toEqual(['__vfs_seq__:session']);
    expect(changed).toHaveBeenCalledWith({ kind: 'ui-state', sessionId: id });
    const before = await repository.getManifest(id);
    get.mockClear(); set.mockClear(); changed.mockClear();
    await repository.updateUIState(id, state);
    expect(get.mock.calls.map(call => call[1]).filter(field => field !== '__vfs_seq__:navigation-version')).toEqual(['__vfs_seq__:session']);
    expect(set).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
    expect(await repository.getManifest(id)).toEqual(before);
    await repository.updateUIState(id, { branchDrafts: { main: { inputText: '' } } });
    expect((await repository.getManifest(id)).uiState?.branchDrafts?.main.inputText).toBe('');
    await repository.updateManifest(id, { currentBranch: 'other', currentHead: 'other' });
    expect(await repository.readHistoryChain(id)).toMatchObject({ branch: 'other', chain: ['other'] });
});
