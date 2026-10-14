import {afterEach, expect, it, vi} from 'vitest';
import type {MCPServer} from '@itookit/tools/mcp-contracts';
import {MCPManager} from '../../src/llm-management/device/mcp-manager';
import {MCPServerConnection} from '../../src/llm-management/skills/mcp-client';

afterEach(() => vi.restoreAllMocks());
function setup() {
    const connected = new WeakSet<MCPServerConnection>();
    const connect = vi.spyOn(MCPServerConnection.prototype, 'connect').mockImplementation(async function(this: MCPServerConnection) {connected.add(this);});
    vi.spyOn(MCPServerConnection.prototype, 'isConnected').mockImplementation(function(this: MCPServerConnection) {return connected.has(this);});
    vi.spyOn(MCPServerConnection.prototype, 'disconnect').mockImplementation(async function(this: MCPServerConnection) {connected.delete(this);});
    const discover = vi.spyOn(MCPServerConnection.prototype, 'discover').mockResolvedValue({tools: [], resources: [], prompts: []});
    const write = vi.fn(), changed = vi.fn();
    const load = vi.fn(async () => [server]);
    const manager = new MCPManager({engineUpsert: write, loadJsonFilesFromDir: load} as never, {createDeviceNode: vi.fn()} as never, changed);
    const server: MCPServer = {id: 'docs', name: 'Documentation', transport: 'http', endpoint: 'https://docs.test/mcp', apiKey: 'private-key'};
    manager.setServers([server]); return {manager, server, connect, discover, write, changed, load};
}
it('reads idle observations without connecting or trusting saved connected flags', async () => {
    const f = setup(); f.manager.setServers([{...f.server, status: 'connected'}]);
    for (let i = 0; i < 3; i++) expect(f.manager.getMCPServers()[0].connectionState).toEqual({status: 'idle', issues: []});
    expect(f.connect).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled(); await f.manager.disconnectAll();
});
it('publishes connecting and connected transitions and resets on explicit disconnect', async () => {
    const f = setup(); let finish!: () => void;
    f.connect.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const opening = f.manager.connectMCPServer(f.server);
    await vi.waitFor(() => expect(f.manager.getMCPServers()[0].status).toBe('connecting'));
    finish(); await opening;
    expect(f.manager.getMCPServers()[0].status).toBe('connected'); expect(f.changed).toHaveBeenCalled();
    await f.manager.disconnectServer(f.server.id); expect(f.manager.getMCPServers()[0].status).toBe('idle'); await f.manager.disconnectAll();
});
it('retains classified connection failure without exposing secrets and clears it on retry', async () => {
    const f = setup(); f.connect.mockRejectedValueOnce(new Error('HTTP 401 Authorization Bearer private-key'));
    await expect(f.manager.testMCPServer(f.server)).rejects.toThrow('401');
    const status = f.manager.getMCPServers()[0].connectionState!;
    expect(status.status).toBe('error'); expect(status.issues).toEqual([{stage: 'connect', reason: 'authentication'}]);
    expect(JSON.stringify(status)).not.toContain('private-key');
    await f.manager.testMCPServer(f.server); expect(f.manager.getMCPServers()[0].connectionState?.issues).toEqual([]);
    expect(f.manager.getMCPServers()[0].status).toBe('connected'); await f.manager.disconnectAll();
});
it('retains discovery failures after closing the unusable connection', async () => {
    const f = setup(); f.discover.mockRejectedValueOnce(new Error('Request timed out'));
    await expect(f.manager.testMCPServer(f.server)).rejects.toThrow('timed out');
    expect(f.manager.getMCPServers()[0].connectionState?.issues).toEqual([{stage: 'discover', reason: 'timeout'}]);
    expect(f.manager.getMCPServers()[0].status).toBe('error'); await f.manager.disconnectAll();
});
it('never writes runtime connection observations into MCP configuration', async () => {
    const f = setup(); await f.manager.testMCPServer(f.server);
    await f.manager.saveMCPServer(f.manager.getMCPServers()[0]);
    const saved = JSON.parse(f.write.mock.calls[0][1]);
    expect(saved.status).toBeUndefined(); expect(saved.connectionState).toBeUndefined();
    expect(f.manager.getMCPServers()[0].status).toBe('connected'); await f.manager.disconnectAll();
});
it('preserves a failed observation during unrelated VFS reloads and invalidates it when connection settings change', async () => {
    const f = setup(); f.connect.mockRejectedValueOnce(new Error('HTTP 401'));
    await expect(f.manager.testMCPServer(f.server)).rejects.toThrow('401');
    await f.manager.reload(); expect(f.manager.getMCPServers()[0].status).toBe('error');
    f.load.mockResolvedValue([{...f.server, apiKey: 'updated'}]); await f.manager.reload();
    expect(f.manager.getMCPServers()[0].status).toBe('idle'); expect(f.connect).toHaveBeenCalledOnce(); await f.manager.disconnectAll();
});
