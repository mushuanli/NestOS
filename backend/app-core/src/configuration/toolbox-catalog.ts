import { createFileSystemSource, MemoryBackend, type FileSystemSourceOwner } from '@itookit/vfs-core';
import { configuredModels, modelCapabilities, runnableModel } from './model-capabilities';
import { createModuleLogger, ENTITY_ICONS, randomUUID, t } from '@itookit/common';
import { type SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import { type MCPServer, type MCPConnectionState } from '@itookit/tools/mcp-contracts';
import { operationModelNames, hasConnectionCredentials, resolveChatModelTiers, resolveModelForTier, type IConnectionService } from '@itookit/kernel-adapters/contracts';
import { type ToolMeta } from '@itookit/tools/contracts';
import { type ToolDefinition } from '@itookit/llm-context';

export interface ToolboxTool { id: string; name: string; description: string; source: string; serverId?: string; enabled: boolean; parameters?: unknown }
import type { RemoteHarnessAgent } from '../projects/remote-agent-catalog';
interface Catalog { listTools(): ToolMeta[]; getToolDefinitions(): ToolDefinition[] }
const log = createModuleLogger('toolbox-catalog');

/** Read-only navigation metadata; configuration remains in its owning services. */
export class ToolboxInventory {
    private readonly backends = { remoteAgents: new MemoryBackend(), mcp: new MemoryBackend(), tools: new MemoryBackend(), providers: new MemoryBackend(), connections: new MemoryBackend(), prompts: new MemoryBackend() };
    private readonly contents = new Map<string, string>();
    private owners: Partial<Record<'remoteAgents' | 'mcp' | 'tools' | 'providers' | 'connections' | 'prompts', FileSystemSourceOwner>> = {};
    readonly remoteAgents = new Map<string, RemoteHarnessAgent>();
    get remoteAgentSource() { return this.owners.remoteAgents!.fs; }
    readonly providers = new Map<string, { id: string; name: string; icon?: string; enabled: boolean; configured: boolean; capabilityTags?: string[]; authentication?: 'chatgpt'; authorizationAvailable?: boolean }>();
    readonly connections = new Map<string, { providerId: string; enabled: boolean; credentialsReady?: boolean; model?: string | null; configuredModel?: string | null; primaryModel?: string | null; primaryCapabilityTags?: string[]; operationModels?: Partial<Record<import('@itookit/kernel-adapters/contracts').ModelOperation, string>>; capabilityTags?: string[] }>();
    defaultConnectionId?: string;
    modelDefaults: import('@itookit/kernel-adapters/contracts').ModelDefaults = {};
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
        const started = performance.now(), operationId = randomUUID();
        const providers = this.models?.getProviders() ?? [];
        const defaults = this.models?.getProviderDefaults() ?? {};
        const connections = await this.models?.getConnections() ?? [];
        this.defaultConnectionId = (await this.models?.getDefaultConnection())?.id;
        this.modelDefaults = await this.models?.getModelDefaults?.() ?? (this.defaultConnectionId ? { chat: this.defaultConnectionId } : {});
        this.providers.clear(); this.connections.clear();
        for (const item of providers) {
            const subscription = item.implementation === 'chatgpt';
            const authorization = subscription ? await this.models?.getProviderAuthorization?.(item.id) : undefined;
            this.providers.set(item.id, { id: item.id, name: item.name, capabilityTags: modelCapabilities(item),
            icon: item.icon === defaults[item.id]?.icon ? undefined : item.icon, enabled: item.enabled !== false,
            ...(subscription ? { authentication: 'chatgpt', authorizationAvailable: authorization?.supported === true } : {}),
            configured: subscription ? authorization?.status === 'authorized' : item.credentialMode === 'host' || item.id === 'codex' || !!(await this.models?.getFullProvider(item.id))?.apiKey?.trim() });
        }
        for (const item of connections) {
            const provider = providers.find(provider => provider.id === item.providerId);
            const [model] = Object.values(resolveChatModelTiers(item, provider));
            const selected = configuredModels(item, provider), available = runnableModel(provider, selected);
            const primary = provider?.models.find(model => model.id === resolveModelForTier(item, 'optimal'));
            this.connections.set(item.id, {providerId: item.providerId, enabled: item.enabled !== false,
                primaryModel: primary ? primary.name || primary.id : null, primaryCapabilityTags: modelCapabilities(provider, primary ? [primary] : []),
                operationModels: operationModelNames(item, provider),
                capabilityTags: modelCapabilities(provider, selected), configuredModel: available ? available.name || available.id : null,
                credentialsReady: hasConnectionCredentials(item), model: model ? model.name || model.id : null});
        }
        log.debug('catalog.models.projected', {operation: 'catalog.models.project', operationId, stage: 'primary-models', result: 'success',
            connections: this.connections.size, missingPrimary: [...this.connections.values()].filter(item => !item.primaryModel).length,
            disabled: [...this.connections.values()].filter(item => !item.enabled).length, durationMs: Math.round(performance.now() - started)});
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
        for (const old of await backend.list('/')) if (!paths.has(old.path)) { await backend.delete(old.path); this.contents.delete(kind + ':' + old.path); }
        for (const item of entries) {
            const path = '/' + encodeURIComponent(item.id) + (kind === 'remoteAgents' ? '.agent' : '');
            const content = JSON.stringify(item), key = kind + ':' + path;
            if (this.contents.get(key) === content) continue;
            await backend.write(path, new TextEncoder().encode(content));
            await backend.updateMetadata(path, { title: item.name, description: item.description, source: item.source,
                icon: item.icon, ...(kind === 'remoteAgents' ? {remoteHarnessAgent: true} : {}),
                ...(kind === 'mcp' ? {mcpStatus: item.status, mcpConnectionState: item.connectionState} : {}), _readOnly: true, _showAll: true });
            this.contents.set(key, content);
        }
    }
    async dispose(): Promise<void> { for (const owner of Object.values(this.owners ?? {})) await owner.dispose(); }
}
