import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { SessionRepository } from '@itookit/llm-session';
import type { ProjectService } from '@itookit/app-contracts/services';
import { ProjectSearch } from '../src/projects/project-search';

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
        const titles = await search.search('/P', {query: 'Session 0', scope: 'session-title'});
        expect(titles.matches).toMatchObject([{kind: 'session', sessionId: id, resourcePath: expect.stringContaining('/folder:%40sessions/' + id)}]);
        expect(read).not.toHaveBeenCalled();
        expect((await search.search('/P', {query: 'Folder', scope: 'session-title'})).matches).toMatchObject([{sessionId: grouped, title: 'Folder note'}]);
        expect((await search.search('/P', {query: 'Folder', scope: 'session-title'})).matches).toHaveLength(1);
        expect((await search.search('/P', {query: 'needle', scope: 'session-prompt'})).matches).toMatchObject([
            {sessionId: id, turnId: 'first', branch: 'main', summary: 'user needle'}, {turnId: 'other', branch: 'fork', summary: 'branch needle'}]);
        expect((await search.search('/P', {query: 'assistant-only', scope: 'session-prompt'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'assistant-only', scope: 'session-content'})).matches).toMatchObject([{sessionId: id, summary: 'assistant-only'}]);
        expect((await search.search('/P', {query: 'system-only', scope: 'session-content'})).matches).toEqual([]);
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
