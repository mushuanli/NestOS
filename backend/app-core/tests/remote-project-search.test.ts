import { expect, it, vi } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { createPiAgentDriver, type RemoteProject } from '@itookit/piagent-driver';
import type { ProjectService } from '@itookit/app-contracts/services';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { ProjectSearch } from '../src/projects/project-search';
import { RemoteMountStore } from '../src/projects/remote-mount-store';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';

async function fixture() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    const fs = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(fs);
    const connection = {id: 'node', name: 'Node', endpoint: 'https://files.test', credentialRef: 'secret', projects: true};
    const grant = {...connection, connectionId: 'node', serverProjectId: 'native', serverProjectRevision: 1,
        at: '/', root: '/a', alias: 'docs', access: 'ro' as const, mountId: 'original'};
    await store.load(); await store.save({version: 1, revision: 1, connections: [connection], projects: {project: [grant]}});
    const project: RemoteProject = {id: 'native', name: 'Native', alias: 'docs', path: 'a', access: 'ro', revision: 1, mounts: []};
    const calls: Array<{name: string; arguments: Record<string, unknown>}> = [];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        if (String(input) !== 'https://files.test/mcp') return new Response(null, {status: 404});
        if (init?.method !== 'POST') return new Response(null, {status: 405});
        const message = JSON.parse(String(init.body));
        if (message.method === 'tools/call') calls.push({name: message.params.name, arguments: message.params.arguments});
        return response(message.id, message.method, message.params, project);
    });
    const driver = createPiAgentDriver(() => 'token', fetch), remote = new ProjectRemoteMountService(fs, driver);
    await remote.init();
    const search = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'project'}}), remoteMounts: remote} as unknown as ProjectService);
    return {search, remote, project, calls, fetch, async dispose() {await remote.dispose(); await runtime.dispose();}};
}

function response(id: unknown, method: string, params: {name: string}, project: RemoteProject): Response {
    const structuredContent = params?.name === 'project_read' ? {project} : params?.name === 'harness_profiles'
        ? {epoch: 'e', profiles: [{id: 'native', kind: 'codex', projectRuntime: true, workspaces: [],
            capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, search: true, searchPrompts: true}}]}
        : {matches: [], truncated: false, nextCursor: null};
    const result = method === 'server/discover'
        ? {supportedVersions: ['2026-07-28'], capabilities: {tools: {}}, _meta: {'itookit/pi-agent': {fileSearch: true, fileSearchVersion: 2}}}
        : {content: [], structuredContent};
    return new Response(JSON.stringify({jsonrpc: '2.0', id, result: {resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result}}),
        {headers: {'content-type': 'application/json'}});
}

it.each(['file-name', 'file-path', 'file-content'] as const)('searches %s through the project MCP transport without rediscovering the HTTP root', async scope => {
    const f = await fixture();
    try {
        expect(await f.search.search('/P', {query: 'needle', scope, directory: 'nested'})).toMatchObject({matches: [], truncated: false});
        expect(f.calls).toEqual([{name: 'project_read', arguments: {projectId: 'native'}},
            {name: 'project_search', arguments: {projectId: 'native', revision: 1, query: 'needle', mode: scope.slice(5), directory: 'nested'}}]);
        expect(f.fetch.mock.calls.every(([url]) => String(url) === 'https://files.test/mcp')).toBe(true);
    } finally {await f.dispose();}
});

it.each(['session-title', 'session-content', 'session-prompt'] as const)('searches %s through the authorized project harness', async scope => {
    const f = await fixture();
    try {
        expect(await f.search.search('/P', {query: 'needle', scope})).toMatchObject({matches: [], truncated: false});
        expect(f.calls.find(call => call.name === 'harness_session_search')?.arguments).toEqual({projectId: 'native', revision: 1,
            profileId: 'native', query: 'needle', mode: scope.slice(8), readOnly: true});
        expect(f.fetch.mock.calls.every(([url]) => String(url) === 'https://files.test/mcp')).toBe(true);
    } finally {await f.dispose();}
});

it('rejects changed project revisions before searching files', async () => {
    const f = await fixture(); f.project.revision++;
    try {
        await expect(f.search.search('/P', {query: 'needle', scope: 'file-name'})).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(f.calls.map(call => call.name)).toEqual(['project_read']);
    } finally {await f.dispose();}
});
