import { afterEach, expect, it, vi } from 'vitest';
import { MCPManager } from '../../src/llm-management/device/mcp-manager';
import { MCPServerConnection } from '../../src/llm-management/skills/mcp-client';
import { mcpTimeoutMs, type MCPServer } from '@itookit/tools/mcp-contracts';

afterEach(() => vi.restoreAllMocks());
function setup() {
    const connected = new WeakSet<MCPServerConnection>();
    const connect = vi.spyOn(MCPServerConnection.prototype, 'connect').mockImplementation(async function (this: MCPServerConnection) { connected.add(this); });
    const disconnect = vi.spyOn(MCPServerConnection.prototype, 'disconnect').mockImplementation(async function (this: MCPServerConnection) { connected.delete(this); });
    vi.spyOn(MCPServerConnection.prototype, 'isConnected').mockImplementation(function (this: MCPServerConnection) { return connected.has(this); });
    const server: MCPServer = { id: 'one', name: 'One', transport: 'http', endpoint: 'https://old.invalid' };
    let saved = [server];
    const helpers = { engineUpsert: vi.fn(async () => {}), loadJsonFilesFromDir: async () => saved,
        getFileSystem: () => ({ driver: { resolvePath: async () => undefined } }) };
    const manager = new MCPManager(helpers as never, { createDeviceNode: async () => {}, removeDeviceNode: async () => {} } as never, () => {});
    manager.setServers(saved);
    return { manager, connect, disconnect, server, helpers, reload: (next: MCPServer[]) => { saved = next; } };
}

it.each(['endpoint', 'apiKey', 'headers', 'args'] as const)('invalidates active transports when %s changes', async field => {
    const { manager, connect, disconnect, server } = setup();
    await manager.connectMCPServer(server);
    const previous = manager.getActiveConn(server.id);
    const updated = { ...server, [field]: field === 'headers' ? { 'x-custom': 'value' } : 'new-value' };
    await manager.saveMCPServer(updated);
    expect(disconnect).toHaveBeenCalledOnce();
    const current = await manager.getOrConnectServer(server.id, manager.getServers());
    expect(current).not.toBe(previous); expect(connect).toHaveBeenCalledTimes(2);
});

it('disconnects removed/reconfigured servers during reload', async () => {
    const { manager, disconnect, server, reload } = setup(); await manager.connectMCPServer(server);
    reload([{ ...server, endpoint: 'https://new.invalid' }]); await manager.reload();
    expect(disconnect).toHaveBeenCalledOnce(); await manager.connectMCPServer(manager.getServers()[0]);
    reload([]); await manager.reload(); expect(disconnect).toHaveBeenCalledTimes(2);
});

it('waits for a pending connection before deleting its process', async () => {
    const { manager, connect, disconnect, server } = setup();
    let release!: () => void; connect.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const opening = manager.connectMCPServer(server); const deleting = manager.deleteMCPServer(server.id);
    await vi.waitFor(() => expect(release).toBeDefined()); release(); await Promise.all([opening, deleting]);
    expect(manager.getActiveConn(server.id)).toBeUndefined(); expect(disconnect).toHaveBeenCalledOnce();
});

it('normalizes legacy UI seconds and preserves explicitly marked millisecond timeouts', () => {
    expect(mcpTimeoutMs({ timeout: 30 })).toBe(30000);
    expect(mcpTimeoutMs({ timeout: 30000 })).toBe(30000);
    expect(mcpTimeoutMs({ timeout: 30, timeoutUnit: 'ms' })).toBe(30);
    expect(() => mcpTimeoutMs({ timeout: -1 })).toThrow();
});

it('serializes config changes behind an opening transport and never resurrects deleted servers', async () => {
    const { manager, connect, disconnect, server } = setup();
    let release!: () => void;
    connect.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const opening = manager.connectMCPServer(server);
    const saving = manager.saveMCPServer({ ...server, endpoint: 'https://new.invalid' });
    await vi.waitFor(() => expect(release).toBeDefined()); release(); await Promise.all([opening, saving]);
    expect(disconnect).toHaveBeenCalledOnce();
    await manager.getOrConnectServer(server.id, [server]); expect(connect).toHaveBeenCalledTimes(2);
    await manager.deleteMCPServer(server.id);
    await expect(manager.getOrConnectServer(server.id, [server])).rejects.toThrow('not configured');
});

it('does not overwrite a concurrent save with an older reload snapshot', async () => {
    const { manager, helpers, server } = setup();
    let release!: (servers: MCPServer[]) => void;
    vi.spyOn(helpers, 'loadJsonFilesFromDir').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reloading = manager.reload();
    await manager.saveMCPServer({ ...server, endpoint: 'https://new.invalid' }); release([server]); await reloading;
    expect(manager.getServers()[0].endpoint).toBe('https://new.invalid');
});

it('rejects unsafe server IDs before persisting configuration', async () => {
    const { manager, helpers, server } = setup();
    expect(() => manager.saveMCPServer({ ...server, id: '../outside' })).toThrow('Invalid MCP server ID');
    expect(() => manager.deleteMCPServer('../outside')).toThrow('Invalid MCP server ID');
    expect(helpers.engineUpsert).not.toHaveBeenCalled();
});

it('rejects legacy transports when saving or testing stored configurations', async () => {
    const { manager, server, connect, helpers } = setup();
    const legacy = { ...server, transport: 'sse' } as unknown as MCPServer;
    expect(() => manager.saveMCPServer(legacy)).toThrow('legacy transports are not supported');
    await expect(manager.testMCPServer(legacy)).rejects.toThrow('legacy transports are not supported');
    expect(connect).not.toHaveBeenCalled(); expect(helpers.engineUpsert).not.toHaveBeenCalled();
});
