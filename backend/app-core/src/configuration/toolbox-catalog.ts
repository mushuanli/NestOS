import { createFileSystemSource, MemoryBackend, type FileSystemSourceOwner } from '@itookit/vfs-core';
import { ENTITY_ICONS, t } from '@itookit/common';
import { type SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import { type MCPServer, type MCPConnectionState } from '@itookit/tools/mcp-contracts';
import { type IConnectionService } from '@itookit/kernel-adapters/contracts';
import { type ToolMeta } from '@itookit/tools/contracts';
import { type ToolDefinition } from '@itookit/llm-context';

export interface ToolboxTool { id: string; name: string; description: string; source: string; serverId?: string; enabled: boolean; parameters?: unknown }
import type { RemoteHarnessAgent } from '../projects/remote-agent-catalog';
interface Catalog { listTools(): ToolMeta[]; getToolDefinitions(): ToolDefinition[] }

/** Read-only navigation metadata; configuration remains in its owning services. */
export class ToolboxInventory {
    private readonly backends = { remoteAgents: new MemoryBackend(), mcp: new MemoryBackend(), tools: new MemoryBackend(), providers: new MemoryBackend(), connections: new MemoryBackend(), prompts: new MemoryBackend() };
    private owners: Partial<Record<'remoteAgents' | 'mcp' | 'tools' | 'providers' | 'connections' | 'prompts', FileSystemSourceOwner>> = {};
    readonly remoteAgents = new Map<string, RemoteHarnessAgent>();
    get remoteAgentSource() { return this.owners.remoteAgents!.fs; }
    readonly providers = new Map<string, { id: string; name: string; icon?: string; enabled: boolean; configured: boolean }>();
    readonly connections = new Map<string, { providerId: string; enabled: boolean }>();
    defaultConnectionId?: string;
    readonly tools = new Map<string, ToolboxTool>();
    constructor(private readonly servers: () => Promise<MCPServer[]>, private readonly catalog: Catalog, private readonly models?: IConnectionService, private readonly prompts?: () => Promise<SystemPromptDefinition[]>, private readonly harnesses?: () => Promise<RemoteHarnessAgent[]>) {}
    async init(): Promise<void> {
        try {
            for (const kind of ['remoteAgents', 'mcp', 'tools', 'providers', 'connections', 'prompts'] as const) this.owners[kind] = await createFileSystemSource({
                backend: this.backends[kind], viewId: 'toolbox:' + kind, access: 'ro' });
            await this.refresh();
        } catch (error) { await this.dispose(); throw error; }
    }
    get sources() { return { prompts: this.owners.prompts!.fs, mcp: this.owners.mcp!.fs, tools: this.owners.tools!.fs, providers: this.owners.providers!.fs, connections: this.owners.connections!.fs }; }

    async refresh(): Promise<void> {
        const servers = await this.servers();
        const harnesses = await this.harnesses?.() ?? [];
        this.remoteAgents.clear();
        for (const agent of harnesses) this.remoteAgents.set(agent.id, agent);
        await this.replace('remoteAgents', harnesses);

        await this.refreshModels();
        await this.replace('prompts', (await this.prompts?.() ?? []).map(item => ({ id: item.id, name: item.name,
            description: item.description ?? item.content.join('\n'), source: '', icon: '' })));
        this.tools.clear();
        const definitions = this.catalog.getToolDefinitions();
        for (const meta of this.catalog.listTools()) {
            const definition = definitions.find(item => (item.function?.name ?? item.name) === meta.id);
            const id = 'builtin:' + meta.id;
            this.tools.set(id, { id, name: meta.name || meta.id, description: meta.description, enabled: meta.enabled,
                source: t(meta.type === 'plugin' ? 'toolbox.plugin' : 'toolbox.builtin'), parameters: definition?.function?.parameters ?? definition?.parameters });
        }
        for (const server of servers) this.addMCPTools(server);
        await this.replace('mcp', servers.map(server => ({ id: server.id, name: server.name, description: server.description ?? '',
            source: server.transport, icon: ENTITY_ICONS.mcp, status: server.status ?? 'idle', connectionState: server.connectionState })));
        await this.replace('tools', [...this.tools.values()].map(tool => ({ ...tool, icon: ENTITY_ICONS.tool })));
    }
    private async refreshModels(): Promise<void> {
        const providers = this.models?.getProviders() ?? [];
        const defaults = this.models?.getProviderDefaults() ?? {};
        const connections = await this.models?.getConnections() ?? [];
        this.defaultConnectionId = (await this.models?.getDefaultConnection())?.id;
        this.providers.clear(); this.connections.clear();
        for (const item of providers) this.providers.set(item.id, { id: item.id, name: item.name,
            icon: item.icon === defaults[item.id]?.icon ? undefined : item.icon, enabled: item.enabled !== false,
            configured: item.id === 'codex' || !!this.models?.getFullProvider(item.id)?.apiKey?.trim() });
        for (const item of connections) this.connections.set(item.id, { providerId: item.providerId, enabled: item.enabled !== false });
        await this.replace('providers', providers.map(item => ({ id: item.id, name: item.name,
            description: item.baseURL ?? '', source: item.implementation, icon: item.icon ?? ENTITY_ICONS.llm })));
        await this.replace('connections', connections.map(item => ({
            id: item.id, name: item.name, description: [item.id === this.defaultConnectionId ? t('connection.default') : '', ...Object.values(item.tiers ?? {})].filter(Boolean).join(' · '),
            source: providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId, icon: ENTITY_ICONS.model })));
    }
    private addMCPTools(server: MCPServer): void {
        for (const raw of server.tools ?? []) {
            if (!raw || typeof raw !== 'object' || !('name' in raw) || typeof raw.name !== 'string') continue;
            const item = raw as { name: string; description?: string; inputSchema?: unknown };
            const id = `mcp:${server.id}:${item.name}`;
            this.tools.set(id, { id, name: item.name, description: item.description ?? '', source: server.name,
                serverId: server.id, enabled: server.status === 'connected', parameters: item.inputSchema });
        }
    }
    private async replace(kind: 'remoteAgents' | 'mcp' | 'tools' | 'providers' | 'connections' | 'prompts', entries: Array<{ id: string; name: string; description: string; source: string; icon: string; status?: MCPServer['status']; connectionState?: MCPConnectionState }>): Promise<void> {
        const backend = this.backends[kind], paths = new Set(entries.map(item => '/' + encodeURIComponent(item.id) + (kind === 'remoteAgents' ? '.agent' : '')));
        for (const old of await backend.list('/')) if (!paths.has(old.path)) await backend.delete(old.path);
        for (const item of entries) {
            const path = '/' + encodeURIComponent(item.id) + (kind === 'remoteAgents' ? '.agent' : '');
            await backend.write(path, new TextEncoder().encode(JSON.stringify(item)));
            await backend.updateMetadata(path, { title: item.name, description: item.description, source: item.source,
                icon: item.icon, ...(kind === 'remoteAgents' ? {remoteHarnessAgent: true} : {}),
                ...(kind === 'mcp' ? {mcpStatus: item.status, mcpConnectionState: item.connectionState} : {}), _readOnly: true, _showAll: true });
        }
    }
    async dispose(): Promise<void> { for (const owner of Object.values(this.owners ?? {})) await owner.dispose(); }
}
