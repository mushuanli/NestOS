import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { RoundLog, SessionRepository } from '@itookit/llm-session';
import type { ProjectService } from '@itookit/app-contracts/services';
import { ProjectSearch } from '../src/projects/project-search';

it('searches distinct ancestor payloads even when branches share the same logical head', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const repository = new SessionRepository(await manager.openFileSystem('/')); await repository.init();
    await repository.createFolder('/P'); const id = await repository.createSession('Shared', '/P');
    const log = new RoundLog(repository, id);
    const make = (round: string, parents: string[], answer: string) => ({id: round, sessionId: id, historyParentIds: parents,
        input: [{role: 'user' as const, content: 'Q'}], output: [{role: 'assistant' as const, content: answer}],
        executions: [], status: 'completed' as const, createdAt: 1, origin: 'user' as const});
    const first = await log.append('main', make('first', [], 'original-only'));
    const head = await log.append('main', make('head', [first], 'last'));
    await log.branchAfterRound(head, 'alternative'); await log.clearAssistantInRound(first);
    await log.setAssistantInRound(first, {assistantMessages: [{role: 'assistant', content: 'alternative-only'}]});
    const search = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'p'}})} as unknown as ProjectService, repository);
    try {
        expect((await search.search('/P', {query: 'original-only', scope: 'session-content'})).matches).toMatchObject([{branch: 'main', turnId: first}]);
        expect((await search.search('/P', {query: 'alternative-only', scope: 'session-content'})).matches).toMatchObject([{branch: 'alternative', turnId: first}]);
    } finally {await repository.dispose(); await manager.dispose();}
});

it('searches unopened sessions and all live branches, with prompts separated from assistant and private context', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    await repository.createFolder('/P'); await repository.createFolder('/P/@sessions'); await repository.createFolder('/Other');
    await repository.createFolder('/P/History'); const grouped = await repository.createSession('Folder note', '/P/History');
    await repository.createFolder('/P/Nested', {id: 'nested-project', directory: '/nested'});
    await repository.createSession('Folder different project', '/P/Nested');
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) ids.push(await repository.createSession(`Session ${i}`, '/P/@sessions'));
    const hidden = await repository.createSession('Other secret', '/Other'), id = ids[0];
    await repository.writeDocument(hidden, 'round-secret.json', JSON.stringify({id: 'secret', input: [{role: 'user', content: 'needle private'}], output: [], historyParentIds: []}));
    await repository.updateManifest(hidden, {currentHead: 'secret', branches: {main: 'secret'}});
    const make = (id: string, text: string, output: string, parent?: string) => JSON.stringify({id, sessionId: ids[0], input: [
        {role: 'system', content: 'system-only needle'}, {role: 'user', content: [{type: 'text', text}]}],
        output: [{role: 'assistant', content: output}], historyParentIds: parent ? [parent] : [], status: 'completed', origin: 'user', createdAt: 1});
    await repository.writeDocument(id, 'round-first.json', make('first', 'user needle', 'assistant-only'));
    await repository.writeDocument(id, 'round-other.json', make('other', 'branch needle', 'another reply', 'first'));
    await repository.updateManifest(id, {currentHead: 'first', currentBranch: 'main', branches: {main: 'first', fork: 'other'}});
    const projects = {forFolder: async () => ({path: '/P', project: {id: 'p'}})} as unknown as ProjectService;
    const search = new ProjectSearch(projects, repository), read = vi.spyOn(repository, 'readDocument');
    try {
        const titles = await search.search('/P', {query: '0 Session', scope: 'session-title'});
        expect(titles.matches).toHaveLength(7);
        expect(titles.matches).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'session', sessionId: id, resourcePath: expect.stringContaining('/folder:%40sessions/' + id)})]));
        expect(read).not.toHaveBeenCalled();
        expect((await search.search('/P', {query: 'Folder', scope: 'session-title'})).matches).toMatchObject([{sessionId: grouped, title: 'Folder note'}]);
        expect((await search.search('/P', {query: 'Folder', scope: 'session-title'})).matches).toHaveLength(1);
        expect((await search.search('/P', {query: 'needle', scope: 'session-prompt'})).matches).toMatchObject([
            {sessionId: id, turnId: 'first', branch: 'main', summary: 'user needle'}, {turnId: 'other', branch: 'fork', summary: 'branch needle'}]);
        expect((await search.search('/P', {query: 'assistant-only', scope: 'session-prompt'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'assistant-only', scope: 'session-content'})).matches).toMatchObject([{sessionId: id, summary: 'assistant-only'}]);
        expect((await search.search('/P', {query: 'system-only', scope: 'session-content'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'NEEDLE　branch', scope: 'session-prompt'})).matches).toMatchObject([{turnId: 'other', summary: 'branch needle'}]);
        expect((await search.search('/P', {query: 'needle assistant-only', scope: 'session-content'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'reply another', scope: 'session-content'})).matches).toMatchObject([{turnId: 'other', summary: 'another reply'}]);
        expect((await search.search('/P', {query: 'Other', scope: 'session-title'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'needle', scope: 'session-prompt', archived: true})).matches).toEqual([]);
    } finally { await repository.dispose(); await manager.dispose(); }
});

it('preserves healthy local results when a native source has no search capability', async () => {
    const repository = {listFolders: async () => [], listSummariesInFolder: async () => [{id: 's', folder: '/P', title: 'needle', updatedAt: 1}]};
    const search = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'p'}}), remoteMounts: {
        list: () => [{at: '/'}], projectHarness: async () => ({profiles: async () => ({profiles: []}), close: async () => {}}),
    }} as unknown as ProjectService, repository as never);
    expect(await search.search('/P', {query: 'needle', scope: 'session-title'})).toMatchObject({matches: [{kind: 'session', sessionId: 's'}], truncated: true, unavailableSources: ['remote']});
});

it('does not claim an unavailable native source for a local project with only a remote reference mount', async () => {
    const projectHarness = vi.fn();
    const repository = {listFolders: async () => [], listSummariesInFolder: async () => [{id: 's', folder: '/P', title: 'needle', updatedAt: 1}]};
    const search = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'p'}}), remoteMounts: {
        list: () => [{at: '/reference'}], projectHarness,
    }} as unknown as ProjectService, repository as never);
    expect(await search.search('/P', {query: 'needle', scope: 'session-title'})).toMatchObject({matches: [{sessionId: 's'}], truncated: false});
    expect(projectHarness).not.toHaveBeenCalled();
});
