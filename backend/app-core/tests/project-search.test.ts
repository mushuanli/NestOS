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
