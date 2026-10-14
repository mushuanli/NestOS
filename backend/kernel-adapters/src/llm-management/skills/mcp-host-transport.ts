import type { Transport, JSONRPCMessage } from '@modelcontextprotocol/client';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import type { MCPServerConfig } from './types';
import type { MCPStdioTransportFactory } from '../contracts/mcp-transport';

export interface MCPProcessBatch { lines: string[]; exited: boolean; error?: string; }
export interface MCPProcessBridge {
    start(config: MCPServerConfig): Promise<string>;
    send(id: string, line: string): Promise<void>;
    poll(id: string): Promise<MCPProcessBatch>;
    stop(id: string): Promise<void>;
}
/** Create a local bridge without changing any other runtime. */
export function createMCPStdioTransportFactory(bridge: MCPProcessBridge): MCPStdioTransportFactory {
    return config => new HostMCPTransport(bridge, config);
}
/** Bounded native polling keeps JSON-RPC off the WebView event thread. */
export class HostMCPTransport implements Transport {
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    onmessage?: Transport['onmessage'];
    private starting?: Promise<string>;
    private id?: string;
    private closed = false;
    private closing?: Promise<void>;
    constructor(private readonly bridge: MCPProcessBridge, private readonly config: MCPServerConfig) {}

    async start(): Promise<void> {
        if (this.starting || this.closed) throw new Error('MCP transport already started or closed');
        this.starting = this.bridge.start(this.config);
        this.id = await this.starting;
        if (this.closed) return;
        void this.read();
    }

    async send(message: JSONRPCMessage): Promise<void> {
        if (!this.id || this.closed) throw new Error('MCP transport is closed');
        await this.bridge.send(this.id, JSON.stringify(message));
    }

    close(): Promise<void> {
        return this.closing ??= this.finish().catch(error => { this.closing = undefined; throw error; });
    }

    private async finish(): Promise<void> {
        this.closed = true;
        const id = this.id ?? await this.starting?.catch(() => undefined);
        if (id) await this.bridge.stop(id);
        this.onclose?.();
    }

    private async read(): Promise<void> {
        try {
            while (!this.closed && this.id) {
                const batch = await this.bridge.poll(this.id);
                if (this.closed) return;
                for (const line of batch.lines) this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
                if (batch.error) throw new Error(batch.error);
                if (batch.exited) throw new Error('MCP server exited');
                await new Promise(resolve => setTimeout(resolve, batch.lines.length ? 0 : 20));
            }
        } catch (error) {
            if (!this.closed) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); await this.close().catch(error => this.onerror?.(error instanceof Error ? error : new Error(String(error)))); }
        }
    }
}
