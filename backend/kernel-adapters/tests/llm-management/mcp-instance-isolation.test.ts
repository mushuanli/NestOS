import { afterEach, expect, it, vi } from 'vitest';
import type { Transport } from '@modelcontextprotocol/client';
import { MCP_PROTOCOL_VERSION } from '@itookit/tools/mcp-contracts';
import { MCPClient, MCPServerConnection } from '../../src/llm-management/skills/mcp-client';
import { LLMDeviceDriver } from '../../src/llm-management/core';
import { MCPManager } from '../../src/llm-management/device/mcp-manager';
import type { MCPConnectionOptions } from '../../src/llm-management/core';

const config = { name: 'shared-name', transport: 'stdio' as const, command: 'unused' };
afterEach(() => vi.unstubAllGlobals());

function hostTransport() {
    const transport: Transport = {
        start: vi.fn(async () => {}), close: vi.fn(async () => { transport.onclose?.(); }),
        send: vi.fn(async message => {
            if (!('id' in message) || !('method' in message)) return;
            transport.onmessage?.({ jsonrpc: '2.0', id: message.id!, result: message.method === 'tools/list' ? { tools: [] } : {
                resultType: 'complete', ttlMs: 0, cacheScope: 'private',
                supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: {},
            } });
        }),
    };
    return transport;
}

it('connects identical configs to independently owned hosts and snapshots caller options', async () => {
    vi.stubGlobal('window', {});
    const first = hostTransport(), second = hostTransport();
    const factoryA = vi.fn(async () => first), factoryB = vi.fn(() => second);
    const identity = { name: 'host-a', version: '2.0.0' };
    const options: MCPConnectionOptions = { stdioTransport: factoryA, clientInfo: identity };
    const a = new MCPServerConnection(config, options);
    const b = new MCPServerConnection(config, { stdioTransport: factoryB });
    options.stdioTransport = false; identity.name = 'mutated';
    try {
        await Promise.all([a.connect(), b.connect()]);
        expect(a.isConnected()).toBe(true); expect(b.isConnected()).toBe(true);
        expect(first.send).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
            _meta: expect.objectContaining({ 'io.modelcontextprotocol/clientInfo': { name: 'host-a', version: '2.0.0' } }),
        }) }));
        expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
            _meta: expect.objectContaining({ 'io.modelcontextprotocol/clientInfo': { name: 'mcp-client', version: '1.0.0' } }),
        }) }));
        expect(factoryA).toHaveBeenCalledWith(config); expect(factoryB).toHaveBeenCalledWith(config);
        await a.disconnect(); expect(first.close).toHaveBeenCalledOnce();
        expect(second.close).not.toHaveBeenCalled(); expect(b.isConnected()).toBe(true);
    } finally { await Promise.all([a.disconnect(), b.disconnect()]); }
    expect(second.close).toHaveBeenCalledOnce();
});

it('propagates asynchronous factory failures and honors explicit stdio disabling', async () => {
    const failure = new Error('host unavailable');
    const factory = vi.fn(async () => { throw failure; });
    const failed = new MCPServerConnection(config, { stdioTransport: factory });
    await expect(failed.connect()).rejects.toBe(failure);
    expect(failed.isConnected()).toBe(false); expect(factory).toHaveBeenCalledOnce();
    const disabled = new MCPServerConnection(config, { stdioTransport: false });
    await expect(disabled.connect()).rejects.toThrow('disabled by the host');
});

it('snapshots driver capability options, including explicit disabling in Node', () => {
    const options: MCPConnectionOptions = { stdioTransport: false };
    const disabled = new LLMDeviceDriver({} as never, { mcp: options });
    options.stdioTransport = vi.fn();
    expect(disabled.supportsMCPStdio()).toBe(false);
    expect(new LLMDeviceDriver({} as never).supportsMCPStdio()).toBe(true);
});

it('forwards instance transports through the client and managed discovery lifecycle', async () => {
    vi.stubGlobal('window', {});
    const transportA = hostTransport(), transportB = hostTransport();
    const factoryA = vi.fn(() => transportA), factoryB = vi.fn(() => transportB);
    const clientOptions: MCPConnectionOptions = { stdioTransport: factoryA };
    const managerOptions: MCPConnectionOptions = { stdioTransport: factoryB };
    const client = new MCPClient({ servers: [config] }, clientOptions);
    const manager = new MCPManager({} as never, {} as never, () => {}, managerOptions);
    clientOptions.stdioTransport = false; managerOptions.stdioTransport = false;
    try {
        await client.initialize();
        const discovery = await manager.testMCPServer({ id: 'one', ...config });
        expect(discovery.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
        expect(factoryA).toHaveBeenCalledOnce(); expect(factoryB).toHaveBeenCalledOnce();
        expect(transportA.start).toHaveBeenCalledOnce(); expect(transportB.start).toHaveBeenCalledOnce();
        await client.disconnectAll(); expect(transportA.close).toHaveBeenCalledOnce();
        expect(transportB.close).not.toHaveBeenCalled();
    } finally { await client.disconnectAll(); await manager.disconnectAll(); }
    expect(transportB.close).toHaveBeenCalledOnce();
});

it('keeps client logging scoped to the injected sink', async () => {
    const failure = new Error('injected host failed');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const options = { logger, stdioTransport: async () => { throw failure; } };
    const first = new MCPClient({ servers: [config] }, options);
    const second = new MCPClient({ servers: [config] }, { stdioTransport: options.stdioTransport });
    await first.initialize(); await second.initialize();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('Failed to connect MCP server', { server: config.name, error: failure.message });
});

it('rejects invalid MCP identity before opening a transport', () => {
    expect(() => new MCPServerConnection(config, { clientInfo: { name: '', version: '1' } })).toThrow('non-empty');
});
