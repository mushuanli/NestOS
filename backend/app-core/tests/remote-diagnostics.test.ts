import { afterEach, expect, it, vi } from 'vitest';
import { getLogger, LogLevel } from '@itookit/common';
import { MemoryBackend } from '@itookit/vfs-core';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { MCPRemoteConnections, PI_AGENT_EXTENSION } from '../src/projects/mcp-remote-connections';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';
import { reportRemoteFailure } from '../src/projects/remote-diagnostics';
import { RemoteMountStore } from '../src/projects/remote-mount-store';

const server: MCPServer = {id: 'office', name: 'Office', transport: 'http', endpoint: 'https://office.test/mcp',
    apiKey: 'private-api-key', auth: {type: 'bearer', credentialRef: 'private-reference'},
    headers: {Authorization: 'private-header'}, extensions: {[PI_AGENT_EXTENSION]: {
        version: 1, mcpEndpoint: 'https://office.test/mcp', httpEndpoint: 'https://office.test',
        fileProtocol: 'fs-agent-http-v1', harness: true}}};
const provider = () => ({setCredential: vi.fn(), dispose: vi.fn(), open: vi.fn()});
afterEach(() => {getLogger().clear(); getLogger().removeModuleLevel('pi-agent'); vi.restoreAllMocks();});

it.each([
    ['ready', {}], ['extension-missing', {extensions: undefined}],
    ['unsupported-transport', {transport: 'stdio'}], ['auth-missing', {auth: undefined, apiKey: undefined}],
    ['endpoint-mismatch', {endpoint: 'https://other.test/mcp'}],
    ['invalid-descriptor', {extensions: {[PI_AGENT_EXTENSION]: {requested: true}}}],
    ['invalid-endpoint', {extensions: {[PI_AGENT_EXTENSION]: {...server.extensions![PI_AGENT_EXTENSION], httpEndpoint: 'https://foreign.test'}}}],
] as const)('distinguishes %s without exposing authentication or endpoint details', async (reason, change) => {
    const registry = new MCPRemoteConnections({getMCPServers: async () => [{...server, ...change} as MCPServer],
        saveMCPServer: vi.fn(), deleteMCPServer: vi.fn()}, provider());
    expect(registry.diagnostic('office').reason).toBe('catalog-not-loaded');
    await registry.refresh();
    const diagnostic = registry.diagnostic('office');
    expect(diagnostic).toMatchObject({connectionId: 'office', connectionName: 'Office', reason, revision: 1});
    expect(registry.diagnostic('deleted').reason).toBe('mcp-not-found');
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-|https:/);
    diagnostic.configured[0].name = 'Changed'; expect(registry.diagnostic('office').connectionName).toBe('Office');
});

it('records the missing binding and its project without remapping it to another MCP', async () => {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    const root = await runtime.vfs.openFileSystem('/'), store = new RemoteMountStore(root), source = provider();
    await store.load();
    await store.save({version: 1, revision: 1, projects: {notes: [{mountId: 'grant', at: '/', root: '/', alias: 'docs',
        access: 'ro', connectionId: 'old-office', endpoint: 'https://office.test', credentialRef: 'private-reference'}]}});
    const registry = new MCPRemoteConnections({getMCPServers: async () => [server], saveMCPServer: vi.fn(), deleteMCPServer: vi.fn()}, source);
    const remote = new ProjectRemoteMountService(root, source, async () => {}, async () => {}, registry);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await remote.init();
        await expect(remote.resolveConnection('old-office')).rejects.toMatchObject({code: 'ENOENT', projectIds: ['notes'],
            diagnostic: {connectionId: 'old-office', reason: 'mcp-not-found', configured: [{id: 'office', name: 'Office'}]}});
        expect(source.open).not.toHaveBeenCalled();
        const logs = getLogger().query({modules: ['pi-agent']}); expect(logs).toHaveLength(1);
        expect(JSON.stringify(logs)).not.toMatch(/private-|https:/);
        expect(consoleError).toHaveBeenCalledOnce();
        expect(consoleError.mock.calls[0][0]).toMatch(/^\d{4}-\d\d-\d\dT.* \[itookit\/pi-agent\]/);
    } finally {await remote.dispose(); await runtime.dispose();}
});

it('does not log provider response bodies, URLs, headers or session content', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportRemoteFailure(new Error('private-response-body https://host/?api_key=private-key'),
        {stage: 'session-list', projectId: 'notes', profileId: 'codex'});
    expect(JSON.stringify(getLogger().query({modules: ['pi-agent']}))).not.toContain('private-');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private-');
});

it('preserves MCP and network cause codes without their sensitive messages', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const network = Object.assign(new Error('private-api-key'), {code: 'ECONNREFUSED'});
    const sdk = Object.assign(new Error('private-response-body', {cause: network}), {code: 'ERA_NEGOTIATION_FAILED'});
    reportRemoteFailure(sdk, {stage: 'mcp-connection-recovery', connectionId: 'office'});
    const log = getLogger().query({modules: ['pi-agent']})[0];
    expect(log.data).toMatchObject({source: 'itookit', code: 'ERA_NEGOTIATION_FAILED', causeCodes: ['ECONNREFUSED']});
    expect(JSON.stringify(log)).not.toContain('private-');
});

it('honors the module SILENT setting in both the log viewer and console', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getLogger().setLevel('pi-agent', LogLevel.SILENT);
    reportRemoteFailure(new Error('Offline'), {stage: 'session-list', projectId: 'notes'});
    expect(getLogger().query({modules: ['pi-agent']})).toEqual([]); expect(consoleError).not.toHaveBeenCalled();
});

it('keeps catalog refresh detail at DEBUG and does not overwrite a newer diagnostic snapshot', async () => {
    getLogger().setLevel('pi-agent', LogLevel.DEBUG);
    let finish!: (value: MCPServer[]) => void;
    const getMCPServers = vi.fn().mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValue([]);
    const registry = new MCPRemoteConnections({getMCPServers, saveMCPServer: vi.fn(), deleteMCPServer: vi.fn()}, provider());
    const old = registry.refresh(); await registry.refresh(); finish([server]); await old;
    expect(registry.diagnostic('office')).toMatchObject({reason: 'mcp-not-found', revision: 2, configured: []});
    expect(getLogger().query({modules: ['pi-agent']}).map(log => log.message)).toEqual(['mcp.catalog.refreshed']);
});

it('recovers a rejected configuration before a foreground capability check', async () => {
    let saved: MCPServer = {...server, extensions: undefined};
    const source = {...provider(), capabilities: vi.fn(async () => ({serverId: null, process: {exec: false}, terminal: {pty: false},
        executionModel: 'none' as const, workspaceConsistency: 'none' as const, readOnlyEnforcement: 'none' as const}))};
    const testMCPServer = vi.fn(async () => ({tools: [], resources: [], prompts: [], extensions: server.extensions}));
    const registry = new MCPRemoteConnections({getMCPServers: async () => [saved], testMCPServer,
        saveMCPServer: async value => {saved = value;}, deleteMCPServer: vi.fn()}, source);
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'});
    const remote = new ProjectRemoteMountService(await runtime.vfs.openFileSystem('/'), source, async () => {}, async () => {}, registry);
    try {
        await remote.init(); expect(registry.diagnostic('office').reason).toBe('extension-missing');
        await remote.executionCapabilities('office');
        expect(registry.diagnostic('office').reason).toBe('ready'); expect(testMCPServer).toHaveBeenCalledOnce();
        expect(source.capabilities).toHaveBeenCalledWith(expect.objectContaining({id: 'office', endpoint: 'https://office.test'}), undefined);
    } finally {await remote.dispose(); await runtime.dispose();}
});
