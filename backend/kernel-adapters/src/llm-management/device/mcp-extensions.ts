import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import type { MCPConfigurationExtension, MCPConfigurationExtensionContext } from '../contracts/mcp-transport';

type Proof = { identity: string; extensions: Record<string, unknown> };

/** One owner for extension discovery and reuse, independent of any settings UI. */
export class MCPConfigurationExtensions {
    private readonly proofs = new Map<string, Proof>();
    constructor(private readonly entries: readonly MCPConfigurationExtension[] = []) {
        const keys = entries.map(entry => entry.key);
        if (keys.some(key => !key.trim()) || new Set(keys).size !== keys.length) throw new Error('Invalid or duplicate MCP extension key');
    }
    async discover(context: MCPConfigurationExtensionContext): Promise<MCPDiscovery> {
        this.forget(context.server.id);
        const extensions: Record<string, unknown> = {};
        for (const entry of this.entries) {
            if (entry.matches(context.server, context.discovery)) extensions[entry.key] = await entry.discover(context);
        }
        this.proofs.set(context.server.id, {identity:mcpConnectionIdentity(context.server),extensions:structuredClone(extensions)});
        return {...context.discovery,extensions};
    }
    async prepare(server: MCPServer, previous: MCPServer | undefined, discover: () => Promise<MCPDiscovery>): Promise<void> {
        if (!this.entries.length) return;
        const identity = mcpConnectionIdentity(server), proof = this.proofs.get(server.id);
        if (proof?.identity === identity) { this.apply(server, proof.extensions); return; }
        if (previous && identity === mcpConnectionIdentity(previous) && this.unchanged(server,previous)) return;
        const snapshot: MCPDiscovery = {tools:Array.isArray(server.tools) ? server.tools as MCPDiscovery['tools'] : [],resources:[],prompts:[]};
        if (!this.entries.some(entry => Object.hasOwn(server.extensions ?? {},entry.key)
            || Object.hasOwn(previous?.extensions ?? {},entry.key) || entry.matches(server,snapshot))) return;
        await discover();
        const verified = this.proofs.get(server.id);
        if (!verified || verified.identity !== identity) throw new Error('MCP configuration changed during discovery');
        this.apply(server,verified.extensions);
    }
    forget(id: string): void { this.proofs.delete(id); }
    clear(): void { this.proofs.clear(); }
    private unchanged(server: MCPServer, previous: MCPServer): boolean {
        return this.entries.every(entry => JSON.stringify(server.extensions?.[entry.key]) === JSON.stringify(previous.extensions?.[entry.key]));
    }
    private apply(server: MCPServer, values: Record<string, unknown>): void {
        const extensions = {...server.extensions};
        for (const entry of this.entries) {
            if (Object.hasOwn(values,entry.key)) extensions[entry.key] = structuredClone(values[entry.key]);
            else delete extensions[entry.key];
        }
        server.extensions = extensions;
    }
}

/** Display names, timeouts and tool presentation do not change the connection identity. */
export function mcpConnectionIdentity(server: MCPServer): string {
    return JSON.stringify([server.transport,server.endpoint,server.command,server.args,server.cwd,server.apiKey,
        server.auth && [server.auth.type,server.auth.username,server.auth.credentialRef],sorted(server.headers),sorted(server.env)]);
}
function sorted(map?: Record<string, string>): [string,string][] { return Object.entries(map ?? {}).sort(([a],[b])=>a.localeCompare(b)); }
