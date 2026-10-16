import { expect, it, vi } from 'vitest';
import { createFileSystemSource, MemoryBackend } from '@itookit/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { PI_AGENT_EXTENSION } from '../src/projects/mcp-remote-connections';
import { canReaddressConnection, type RemoteFileSystemConfig } from '../src/projects/remote-connections';
import { mockPiAgentDiscovery } from './helpers/mcp-discovery';

const authorization = { principalId: 'owner', anonymous: false, revision: 'a'.repeat(64) };
const original: RemoteFileSystemConfig = { id: 'node', name: 'Node', endpoint: 'http://files.test:8787',
    serverId: 'stable-node', credentialRef: 'credential', authorization };

it.each([
    { serverId: 'different-node' },
    { serverId: undefined },
    { authorization: undefined },
    { authorization: { ...authorization, principalId: 'another-user' } },
    { authorization: { ...authorization, anonymous: true } },
    { authorization: { ...authorization, revision: 'b'.repeat(64) } },
])('rejects a location change with a different or missing identity: %j', change => {
    expect(canReaddressConnection(original, { ...original, endpoint: 'http://127.0.0.1:8787', ...change })).toBe(false);
});

it('requires a known original identity before changing its location', () => {
    expect(canReaddressConnection({ ...original, serverId: undefined }, original)).toBe(false);
    expect(canReaddressConnection({ ...original, authorization: undefined }, original)).toBe(false);
});

it('only upgrades an implicit legacy owner when its original credential is retained', () => {
    const legacy = { ...original, authorization: undefined };
    expect(canReaddressConnection(legacy, original, true)).toBe(true);
    expect(canReaddressConnection(legacy, original, false)).toBe(false);
    expect(canReaddressConnection(legacy, { ...original, authorization: { ...authorization, principalId: 'shang' } }, true)).toBe(false);
    expect(canReaddressConnection({ ...legacy, serverId: undefined }, original, true)).toBe(false);
});

async function fixture(legacy = false) {
    const descriptor = { version: 1, fileProtocol: 'fs-agent-http-v1', httpEndpoint: './',
        serverId: 'stable-node', harness: false, authorization: legacy ? undefined : authorization };
    const fetch = mockPiAgentDiscovery(descriptor);
    const disposed = vi.fn(), opened: string[] = [];
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), ownerKind: 'web', remoteSourceProvider: {
        setCredential() {}, async dispose() {}, async open(connection) {
            opened.push(connection.endpoint);
            const backend = new MemoryBackend(); await backend.init();
            await backend.write('/note.txt', new TextEncoder().encode(connection.endpoint));
            const owner = await createFileSystemSource({ backend, viewId: connection.endpoint, access: 'ro' });
            const dispose = owner.dispose.bind(owner);
            owner.dispose = async () => { disposed(connection.endpoint); await dispose(); };
            return owner;
        },
    } });
    const remote = runtime.projects.remoteMounts!;
    try {
        await runtime.agentService.saveMCPServer({ id: 'node', name: 'Node', transport: 'http',
            endpoint: 'http://files.test:8787/mcp', apiKey: 'test-credential',
            extensions: { [PI_AGENT_EXTENSION]: { requested: true } } });
        const project = await runtime.projects.createRemote('Bound', null, 'node', '/docs', 'ro');
        const configured = (await runtime.agentService.getMCPServers()).find(server => server.id === 'node')!;
        return { runtime, remote, project, configured, fetch, disposed, opened, descriptor,
            async dispose() { await runtime.dispose(); fetch.mockRestore(); } };
    } catch (error) { await runtime.dispose(); fetch.mockRestore(); throw error; }
}

it('rediscovers a new address and preserves project references while releasing old file views', async () => {
    const f = await fixture(), { runtime, remote, project, configured, fetch, disposed, opened } = f;
    try {
        const originalMount = remote.list(project.project.id)[0];
        const oldFiles = await runtime.projects.openFiles(project.path);
        expect(await oldFiles.fs.driver.readContent('/note.txt', { encoding: 'utf-8' })).toBe(original.endpoint);
        fetch.mockClear();
        await runtime.agentService.saveMCPServer({ ...configured, endpoint: 'http://127.0.0.1:8787/mcp' });
        expect(fetch.mock.calls.some(([url]) => String(url) === 'http://127.0.0.1:8787/mcp')).toBe(true);
        expect(disposed).toHaveBeenCalledWith(original.endpoint);
        expect(remote.list(project.project.id)[0]).toEqual({ ...originalMount, endpoint: 'http://127.0.0.1:8787' });
        expect(remote.findRemoteProject('node', '/docs')).toBe(project.project.id);
        const newFiles = await runtime.projects.openFiles(project.path);
        try {
            expect(await newFiles.fs.driver.readContent('/note.txt', { encoding: 'utf-8' })).toBe('http://127.0.0.1:8787');
        } finally { await newFiles.dispose(); await oldFiles.dispose(); }
        expect(opened).toContain('http://127.0.0.1:8787');
    } finally { await f.dispose(); }
});

it('moves a legacy connection to loopback using its existing credential and newly discovered owner', async () => {
    const f = await fixture(true);
    try {
        expect(f.remote.connection('node').authorization).toBeUndefined();
        f.descriptor.authorization = authorization;
        await f.runtime.agentService.saveMCPServer({ ...f.configured, endpoint: 'http://127.0.0.1:8787/mcp' });
        expect(f.remote.connection('node')).toMatchObject({ endpoint: 'http://127.0.0.1:8787', authorization });
        expect(f.remote.findRemoteProject('node', '/docs')).toBe(f.project.project.id);
    } finally { await f.dispose(); }
});

it('refuses changing the credential during a legacy address migration', async () => {
    const f = await fixture(true);
    try {
        f.descriptor.authorization = authorization;
        await expect(f.runtime.agentService.saveMCPServer({ ...f.configured, endpoint: 'http://127.0.0.1:8787/mcp', apiKey: 'replacement-credential' }))
            .rejects.toMatchObject({ code: 'EBUSY' });
        expect(f.remote.connection('node').endpoint).toBe(original.endpoint);
    } finally { await f.dispose(); }
});

it.each(['node', 'principal', 'revision', 'missing-authorization', 'unreachable'])('retains the saved connection after rejected discovery: %s', async reason => {
    const f = await fixture();
    try {
        if (reason === 'node') f.descriptor.serverId = 'different-node';
        if (reason === 'principal') f.descriptor.authorization = { ...authorization, principalId: 'different-user' };
        if (reason === 'revision') f.descriptor.authorization = { ...authorization, revision: 'b'.repeat(64) };
        if (reason === 'missing-authorization') Reflect.deleteProperty(f.descriptor, 'authorization');
        if (reason === 'unreachable') f.fetch.mockRejectedValue(new Error('Connection refused'));
        await expect(f.runtime.agentService.saveMCPServer({ ...f.configured, endpoint: 'http://other.test:8787/mcp' })).rejects.toThrow();
        expect(f.remote.connection('node').endpoint).toBe(original.endpoint);
        expect((await f.runtime.agentService.getMCPServers()).find(server => server.id === 'node')?.endpoint).toBe(f.configured.endpoint);
    } finally { await f.dispose(); }
});
