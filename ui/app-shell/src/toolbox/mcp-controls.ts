import type { MCPDiscovery, MCPServer } from '@itookit/tools/mcp-contracts';
import type { ConfigurationFormControls } from '@itookit/ui-common';

type Controls = ConfigurationFormControls<MCPServer,MCPDiscovery>;
interface Entry { key: string; controls: Controls; matches(server: MCPServer): boolean }

/** Views are selected locally; protocol and business discovery belong to the management service. */
export class MCPConfigurationControlsRegistry implements Controls {
    private readonly entries: Entry[] = [];
    register(key: string, controls: Controls, matches: Entry['matches'] = server => Object.hasOwn(server.extensions ?? {},key)): this {
        if (this.entries.some(entry => entry.key === key)) throw new Error('Duplicate MCP controls key');
        this.entries.push({key,controls,matches}); return this;
    }
    render(parent: HTMLElement, server: MCPServer): void {
        for (const entry of this.entries) if (entry.matches(server)) entry.controls.render(parent,server);
    }
    read(server: MCPServer): MCPServer {
        for (const entry of this.entries) if (entry.matches(server)) server = entry.controls.read(server);
        return server;
    }
    async tested(server: MCPServer, discovery: MCPDiscovery): Promise<MCPServer> {
        for (const entry of this.entries) if (entry.matches(server)) server = await entry.controls.tested?.(server,discovery) ?? server;
        return server;
    }
    committed(): void { for (const entry of this.entries) entry.controls.committed?.(); }
    failed(): void { for (const entry of this.entries) entry.controls.failed?.(); }
    dispose(): void { for (const entry of this.entries) entry.controls.dispose?.(); this.entries.length = 0; }
}
