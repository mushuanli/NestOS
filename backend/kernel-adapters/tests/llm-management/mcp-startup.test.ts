import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { LLMDeviceDriver } from '../../src/llm-management/core';
import { MCPManager } from '../../src/llm-management/device/mcp-manager';
import { MCPServerConnection } from '../../src/llm-management/skills/mcp-client';
import type { MCPServer } from '@itookit/tools/mcp-contracts';

afterEach(() => vi.restoreAllMocks());
async function fixture(servers: MCPServer[]) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const config = await manager.openFileSystem('/etc');
    for (const server of servers) await config.driver.createFile({ parentPath: '/llm/.mcp', name: server.id + '.json', content: JSON.stringify(server), recursive: true });
    const driver = new LLMDeviceDriver(manager, { mcp: { stdioTransport: false } }); manager.devices.register(driver); manager.devices.freeze();
    vi.spyOn(MCPServerConnection.prototype, 'isConnected').mockReturnValue(true);
    vi.spyOn(MCPServerConnection.prototype, 'disconnect').mockResolvedValue();
    vi.spyOn(MCPServerConnection.prototype, 'discover').mockResolvedValue({ tools: [], resources: [], prompts: [] });
    return { driver, close: async () => { await driver.dispose(); await manager.dispose(); } };
}
const server = (id: string, options: Partial<MCPServer> = {}): MCPServer => ({ id, name: id, transport: 'http', endpoint: 'https://example.invalid/mcp', ...options });

it('starts configured MCPs without a UI, defaults to connecting, and keeps LLM readiness independent', async () => {
    const f = await fixture([server('default'), server('enabled', { autoConnect: true }), server('disabled', { autoConnect: false }),
        server('draft', { endpoint: '' }), server('unsupported', { transport: 'stdio', command: 'unused' })]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const connect = vi.spyOn(MCPServerConnection.prototype, 'connect').mockImplementation(() => blocked);
    const initialize = vi.spyOn(MCPManager.prototype, 'initializeMCPServer');
    try {
        await f.driver.init(); await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
        expect(initialize.mock.calls.map(([id]) => id).sort()).toEqual(['default', 'enabled']);
        expect((await f.driver.getMCPServers()).filter(item => item.status === 'connecting')).toHaveLength(2);
        let ready = false;
        const startup = f.driver.waitForMCPStartup().then(() => { ready = true; });
        await Promise.resolve(); expect(ready).toBe(false);
        await f.driver.init(); expect(connect).toHaveBeenCalledTimes(2);
        release(); await startup;
        expect((await f.driver.getMCPServers()).filter(item => item.status === 'connected')).toHaveLength(2);
    } finally { release(); await f.close(); }
});

it('isolates connection failures and drains other startup connections during shutdown', async () => {
    const f = await fixture([server('failing'), server('healthy')]);
    vi.spyOn(MCPServerConnection.prototype, 'connect').mockRejectedValueOnce(new Error('offline')).mockResolvedValue();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await f.driver.init();
        await f.driver.waitForMCPStartup();
        await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
        await vi.waitFor(async () => expect(await f.driver.getMCPServers()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'failing', status: 'error' }), expect.objectContaining({ id: 'healthy', status: 'connected' }),
        ])));
    } finally { await f.close(); }
});

it('classifies MCP startup transport failures without logging credentials or raw exceptions', async () => {
    const f = await fixture([server('failing', {endpoint: 'https://example.invalid/mcp?key=private-key'})]);
    vi.spyOn(MCPServerConnection.prototype, 'connect').mockRejectedValue(new TypeError('Failed to fetch private-key'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
        await f.driver.init(); await f.driver.waitForMCPStartup();
        await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
        expect(warning).toHaveBeenCalledWith('[LLMDeviceDriver] MCP startup connection failed', expect.objectContaining({
            operation: 'mcp.startup', operationId: 'failing', serverId: 'failing', stage: 'connect', code: 'MCP_NETWORK', outcome: 'failure',
        }));
        expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-key|Failed to fetch|example.invalid/);
    } finally {await f.close();}
});
