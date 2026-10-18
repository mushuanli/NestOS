import { expect, it, vi } from 'vitest';
import { createFileSystemSource, MemoryBackend } from '@itookit/vfs-core';
import { ProjectSearch } from '../src/projects/project-search';
import type { ProjectService } from '../src/projects/project-service';

const project = {path: '/P', project: {id: 'local-p'}};
it('searches unopened local directories with ignored, private and binary files excluded', async () => {
    const owner = await createFileSystemSource({backend: new MemoryBackend(), viewId: 'search', tags: false});
    await owner.fs.driver.createFile({parentPath: '/nested', name: 'notes.md', content: 'old\nneedle quoted "text"\nend', recursive: true});
    await owner.fs.driver.createFile({parentPath: '/', name: '.gitignore', content: 'ignored.txt'});
    await owner.fs.driver.createFile({parentPath: '/', name: 'ignored.txt', content: 'needle'});
    await owner.fs.driver.createFile({parentPath: '/.codex', name: 'auth.json', content: 'needle', recursive: true});
    await owner.fs.driver.createFile({parentPath: '/', name: 'binary.bin', content: 'needle\0payload'});
    const dispose = vi.fn(async () => {});
    const projects = {forFolder: async () => project, openFiles: async () => ({fs: owner.fs, dispose}),
        remoteMounts: {list: () => [{at: '/reference'}]}} as unknown as ProjectService;
    const search = new ProjectSearch(projects);
    expect((await search.search('/P', {query: 'notes', scope: 'file-path'})).matches).toMatchObject([{path: 'nested/notes.md'}]);
    expect((await search.search('/P', {query: 'needle', scope: 'file-content'})).matches).toEqual([
        {kind: 'file', projectId: 'local-p', folder: '/P', path: 'nested/notes.md', title: 'nested/notes.md', line: 2, summary: 'needle quoted "text"'}]);
    expect(dispose).toHaveBeenCalledTimes(2); await owner.dispose();
});
it('keeps remote identity and explicit scope and rejects responses after grant changes', async () => {
    let revision = 1;
    const client = {profiles: vi.fn(async () => ({profiles: [{id: 'native', projectRuntime: true, capabilities: {search: true}}]})),
        search: vi.fn(async () => ({matches: [{sessionId: 's', title: 'Second page', summary: 'old content', itemId: 'early'}], truncated: true, nextCursor: null})),
        close: vi.fn(async () => {})};
    const remote = {list: () => [{connectionId: 'mcp', serverId: 'server', serverProjectId: 'p', revision}], projectHarness: async () => client};
    const search = new ProjectSearch({forFolder: async () => project, remoteMounts: remote} as unknown as ProjectService);
    const result = await search.search('/P', {query: 'old', scope: 'session-content', archived: true});
    expect(client.search).toHaveBeenCalledWith('native', {query: 'old', mode: 'content', archived: true}, expect.objectContaining({signal: expect.any(AbortSignal)}));
    expect(result).toMatchObject({truncated: true, matches: [{projectId: 'local-p', profileId: 'native', sessionId: 's', itemId: 'early', bindingIdentity: expect.any(String)}]});
    client.search.mockImplementation(async () => { revision++; return {matches: [], truncated: false, nextCursor: null}; });
    await expect(search.search('/P', {query: 'old', scope: 'session-content'})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(client.close).toHaveBeenCalledTimes(2);
});
it('does not fall back to histories or shell commands on an unsupported harness', async () => {
    const close = vi.fn(async () => {}), read = vi.fn();
    const search = new ProjectSearch({forFolder: async () => project, remoteMounts: {list: () => [], projectHarness: async () => ({read, close,
        profiles: async () => ({profiles: [{id: 'old', projectRuntime: true, capabilities: {history: true}}]})})}} as unknown as ProjectService);
    await expect(search.search('/P', {query: 'needle', scope: 'session-content'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('limits recursive file queries before matching and distinguishes names from paths', async () => {
    const owner = await createFileSystemSource({backend: new MemoryBackend(), viewId: 'scoped-search', tags: false});
    await owner.fs.driver.createFile({parentPath: '/needle/child', name: 'plain.txt', content: 'target', recursive: true});
    await owner.fs.driver.createFile({parentPath: '/other', name: 'needle.txt', content: 'target', recursive: true});
    const dispose = vi.fn(async () => {});
    const search = new ProjectSearch({forFolder: async () => project, openFiles: async () => ({fs: owner.fs, dispose})} as unknown as ProjectService);
    try {
        expect((await search.search('/P', {query: 'needle', scope: 'file-name', directory: 'needle'})).matches).toEqual([]);
        expect((await search.search('/P', {query: 'needle', scope: 'file-path', directory: 'needle'})).matches).toMatchObject([{path: 'needle/child/plain.txt'}]);
        expect((await search.search('/P', {query: 'target', scope: 'file-content', directory: 'needle'})).matches).toMatchObject([{path: 'needle/child/plain.txt'}]);
        for (const directory of ['../other', '/other', 'a//b', 'a/../b', 'a\\b'])
            await expect(search.search('/P', {query: 'x', scope: 'file-name', directory})).rejects.toMatchObject({code: 'EINVAL'});
        const controller = new AbortController(); controller.abort();
        await expect(search.search('/P', {query: 'x', scope: 'file-name'}, {signal: controller.signal})).rejects.toBeDefined();
        expect(dispose).toHaveBeenCalledTimes(3);
    } finally { await owner.dispose(); }
});

it('aggregates healthy native prompt searches and reports unsupported or failed profiles', async () => {
    const client = {profiles: async () => ({profiles: [
        {id: 'good', projectRuntime: true, capabilities: {search: true, searchPrompts: true}},
        {id: 'old', projectRuntime: true, capabilities: {search: true}},
        {id: 'broken', projectRuntime: true, capabilities: {search: true, searchPrompts: true}},
    ]}), search: vi.fn(async (id: string) => {
        if (id === 'broken') throw new Error('unavailable');
        return {matches: [{sessionId: 's', title: 'Found', summary: 'user needle', updatedAt: 1}], truncated: false, nextCursor: null};
    }), close: vi.fn(async () => {})};
    const search = new ProjectSearch({forFolder: async () => project, remoteMounts: {list: () => [], projectHarness: async () => client}} as unknown as ProjectService);
    expect(await search.search('/P', {query: 'needle', scope: 'session-prompt'})).toMatchObject({matches: [{profileId: 'good', sessionId: 's'}], truncated: true, unavailableSources: ['old', 'broken']});
    expect(client.search.mock.calls.map(args => args[0])).toEqual(['good', 'broken']); expect(client.close).toHaveBeenCalledOnce();
});

it('forwards remote name/directory scopes and rejects file results when grants change', async () => {
    let revision = 1;
    const remote = {list: () => [{at: '/', revision}], searchFiles: vi.fn(async () => ({matches: [{path: 'nested/old.md', summary: 'old.md'}], truncated: false, nextCursor: null}))};
    const search = new ProjectSearch({forFolder: async () => project, remoteMounts: remote} as unknown as ProjectService);
    expect((await search.search('/P', {query: 'old', scope: 'file-name', directory: 'nested'})).matches).toMatchObject([{kind: 'file', path: 'nested/old.md', bindingIdentity: JSON.stringify(remote.list())}]);
    expect(remote.searchFiles).toHaveBeenCalledWith('local-p', {query: 'old', mode: 'name', directory: 'nested'}, expect.anything());
    remote.searchFiles.mockImplementation(async () => { revision++; return {matches: [], truncated: false, nextCursor: null}; });
    await expect(search.search('/P', {query: 'old', scope: 'file-name', directory: 'nested'})).rejects.toMatchObject({code: 'ECONFLICT'});
});

it('filters session search by creation source before applying the result limit', async () => {
    const rows = Array.from({length: 130}, (_, index) => ({id: 'other-' + index, title: 'Needle other', updatedAt: 2000, folder: '/P', createdWithAgentId: 'other'}));
    rows.push({id: 'writer', title: 'Needle writer', updatedAt: 1000, folder: '/P', createdWithAgentId: 'writer'});
    const repository = {listFolders: async () => [], listSummaries: async () => rows};
    const search = new ProjectSearch({forFolder: async () => project} as never, repository as never);
    expect((await search.search('/P', {query: 'Needle', scope: 'session-title', agentId: 'writer'})).matches).toMatchObject([{sessionId: 'writer'}]);
});
