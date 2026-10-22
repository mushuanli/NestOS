import type { ProviderConnectionTestParams } from '@itookit/driver-llm/contracts';
// @file: llm-conversation/src/services/vfs-agent-service.ts
//
// Agent VFS 持久化服务。
// 连接 / MCP / Skill 管理全部委托给注入的 ILLMManagementService（由 LLMDeviceDriver 实现）。

import { FileBackedService } from '../utils/file-backed-service';
import type { IFileSystem } from '@itookit/vfs-core';
import type { FSNode, FSSearchQuery } from '@itookit/vfs-core';
import type { RestorableItem } from '../contracts';
import type { ILLMManagementService, AgentDefinition, LLMSkill, InitialAgentDef, DefaultConnectionDef } from '../contracts';
import type { ConnectionMeta, LLMConnection, LLMProvider, ConnectionTestResult } from '@itookit/driver-llm/contracts';
import type { MCPServer } from '@itookit/tools/mcp-contracts';
import type { SystemPromptDefinition } from '@itookit/llm-tasks/contracts';

import { IAgentManagementService } from './agent-service';
import { createSessionHost, type SessionHost } from '../utils/host-ports';

// Agent 默认存储目录（VFS module-relative path）
const AGENT_DEFAULT_DIR = '/default';

// ─── 常量 ──────────────────────────────────────────────────────────────────────

const VERSION_FILE = '/.defaults_version.json';

// ─── VFSAgentService ──────────────────────────────────────────────────────────

export class VFSAgentService extends FileBackedService implements IAgentManagementService {
    private _agents: AgentDefinition[] = [];
    private _agentNodeIds = new Map<string, string>(); // agentId → VFS node ID
    private _duplicatePaths = new Map<string, string[]>(); // agentId → duplicate paths (cleaned on scan)
    private _syncTimer: ReturnType<typeof setTimeout> | null = null;
    private _eventUnsubscribers: Array<() => void> = [];
    private _systemPromptCache = new Map<string, SystemPromptDefinition>();
    private _systemPromptListLoaded = false;

    constructor(
        fs: IFileSystem,
        private readonly llmService: ILLMManagementService,
        private readonly host: SessionHost = createSessionHost(),
    ) {
        super(fs, host.logger);
    }

    // ─── FileBackedService lifecycle ─────────────────────────────────────────

    protected override waitForLoad(): Promise<void> { return this.init(); }

    protected async onLoad(): Promise<void> {
        await this.ensureDefaults();
        await this.refreshData();
        this.bindVFSEvents();
        // 连接变更时同步通知，保持 IAgentConfigService.onChange 语义不变
        this._eventUnsubscribers.push(
            this.llmService.onChange(() => this.notify()),
        );
    }

    private bindVFSEvents(): void {
        const debounce = () => {
            this._systemPromptCache.clear(); this._systemPromptListLoaded = false;
            if (this._syncTimer) clearTimeout(this._syncTimer);
            this._syncTimer = setTimeout(async () => {
                await this.refreshData();
                this.notify();
            }, 300);
        };

        this._eventUnsubscribers.push(
            this.engine.on('node:created', () => debounce()),
            this.engine.on('node:updated', () => debounce()),
            this.engine.on('node:deleted', () => debounce()),
            this.engine.on('node:renamed', () => debounce()),
        );
    }

    // ─── Data refresh ─────────────────────────────────────────────────────────

    /** Cancel any pending VFS-event-driven refresh — used after local writes */
    private cancelPendingSync(): void {
        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
    }

    private async refreshData(): Promise<void> {
        try {
            this._agents = await this.scanAgentFiles();
            this.host.logger.info('Agent service data refreshed', { agentCount: this._agents.length });
        } catch (e) {
            this.host.logger.error('Failed to refresh agent service data', { error: e });
        }
    }

    // ─── Defaults ─────────────────────────────────────────────────────────────

    private async ensureDefaults(): Promise<void> {
        try {
            const configVersion = this.llmService.getConfigVersion();
            const versionData = await this.readJson<{ version: number }>(VERSION_FILE);
            if (versionData && versionData.version >= configVersion) return;
            this.host.logger.info('Syncing default agents');
            await this.syncDefaultAgents();
            await this.syncDefaultSystemPrompts();
            await this.writeJson(VERSION_FILE, { version: configVersion, updatedAt: Date.now() });
        } catch (e) {
            this.host.logger.error('Failed to ensure defaults', { error: e });
        }
    }

    private async syncDefaultAgents(): Promise<void> {
        let created = 0;

        for (const def of this.llmService.getDefaultAgents()) {
            const filename = `${def.id}.agent`;
            const parentDir = def.initPath || AGENT_DEFAULT_DIR;
            const fullPath = `${parentDir}/${filename}`.replace(/\/+/g, '/');
            if (await this.engine.driver.exists(fullPath)) continue;

            const { initPath, initialTags, ...content } = def;

            try {
                await this.ensureDirectory(parentDir);
                const node = await this.engine.driver.createFile({
                    name: filename,
                    parentPath: parentDir,
                    content: JSON.stringify(sharedPromptAgent(content), null, 2),
                    metadata: { icon: def.icon || '🤖', title: def.name, description: def.description },
                });
                if (initialTags?.length && node?.path) await this.engine.meta.tags?.setTags(node.path, initialTags);
                created++;
            } catch { /* ignore per-agent errors */ }
        }

        this.host.logger.info('Default agents synced', { created });
    }

    /** Seed each default agent's system prompt + quick-prompt presets as a System Prompt library entry. */
    private async syncDefaultSystemPrompts(): Promise<void> {
        for (const def of this.llmService.getDefaultAgents()) {
            // Variants reference a shared entry via config.systemPromptId (no inline
            // systemPrompt), so they are skipped — dedupes the shared prompt/presets.
            if (!def.config.systemPrompt) continue;
            const entry = defaultPrompt(def);
            const path = `/system-prompts/${def.id}.sp`;
            try {
                if (await this.readJson(path)) continue;
                await this.writeJson(path, entry);
            } catch (error) {
                this.host.logger.error('Failed to sync default system prompt', { id: def.id, error });
            }
        }
    }

    // ─── IAgentConfigService — reads ────────────────────────────────────────────────

    listAgents(): AgentDefinition[] {
        return [...this._agents];
    }

    getAgentResourceId(id: string): string | undefined { return this._agentNodeIds.get(id); }

    findAgent(id: string): AgentDefinition | undefined {
        return this._agents.find(a => a.id === id);
    }

    /** Resolve a System Prompt library entry (stored as /system-prompts/{id}.sp), in-memory cached. */
    async getSystemPrompt(id: string): Promise<SystemPromptDefinition | null> {
        await this.waitForLoad();
        if (!id) return null;
        const cached = this._systemPromptCache.get(id);
        if (cached) return cached;
        const loaded = await this.readJson<SystemPromptDefinition>(`/system-prompts/${id}.sp`);
        if ((loaded as { __deleted?: boolean } | null)?.__deleted) return null;
        if (loaded) this._systemPromptCache.set(id, loaded);
        return loaded;
    }

    async listSystemPrompts(): Promise<SystemPromptDefinition[]> {
        await this.waitForLoad();
        if (this._systemPromptListLoaded) return [...this._systemPromptCache.values()];
        try {
            const result = await this.engine.driver.search({ name: { contains: '.sp' }, type: 'file' });
            const prompts = await Promise.all(Array.from(result.nodes).map(async node => {
                if (!node.name.endsWith('.sp')) return null;
                const content = await this.engine.driver.readContent(node.path);
                if (!content) return null;
                const str = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
                return JSON.parse(str) as SystemPromptDefinition;
            }));
            const valid = prompts.filter((p): p is SystemPromptDefinition => Boolean(p?.id) && !(p as { __deleted?: boolean }).__deleted);
            for (const p of valid) this._systemPromptCache.set(p.id, p);
            this._systemPromptListLoaded = true;
            return valid;
        } catch {
            return [];
        }
    }

    async saveSystemPrompt(prompt: SystemPromptDefinition): Promise<void> {
        await this.waitForLoad();
        assertPromptId(prompt.id);
        if (!prompt.name?.trim() || !Array.isArray(prompt.content) || prompt.content.some(part => typeof part !== 'string'))
            throw new Error('Invalid system prompt');
        await this.writeJson(`/system-prompts/${prompt.id}.sp`, prompt);
        this._systemPromptCache.set(prompt.id, structuredClone(prompt));
        this.notify();
    }

    async deleteSystemPrompt(id: string): Promise<void> {
        await this.waitForLoad();
        if (!id?.trim()) return;
        assertPromptId(id);
        if (this.llmService.getDefaultAgents().some(agent => agent.id === id))
            await this.writeJson(`/system-prompts/${id}.sp`, { id, __deleted: true });
        else await this.engine.driver.delete([`/system-prompts/${id}.sp`]);
        this._systemPromptCache.delete(id);
        this.notify();
    }

    listConnections(): ConnectionMeta[] {
        return this.llmService.listConnections();
    }

    findConnection(id: string): ConnectionMeta | undefined {
        return this.llmService.findConnection(id);
    }

    async getAgents(): Promise<AgentDefinition[]> {
        await this.waitForLoad();
        return [...this._agents];
    }

    async getAgentConfig(agentId: string): Promise<AgentDefinition | null> {
        await this.waitForLoad();
        let found = this._agents.find(a => a.id === agentId);
        if (!found && agentId === 'default') {
            found = {
                id: 'default', name: 'Default Assistant', type: 'agent',
                icon: '🤖', description: 'Built-in default assistant',
                config: {},
            };
        }
        if (!found) return null;

        const result: AgentDefinition = JSON.parse(JSON.stringify(found));
        return result;
    }

    async getConnection(id: string): Promise<ConnectionMeta | undefined> {
        return this.llmService.getConnection(id);
    }

    async getDefaultConnection(operation?: import('@itookit/kernel-adapters/contracts').ModelOperation): Promise<ConnectionMeta | null> {
        return this.llmService.getDefaultConnection(operation);
    }
    async setDefaultConnection(id: string | null): Promise<void> { return this.llmService.setDefaultConnection(id); }
    getModelDefaults() { return this.llmService.getModelDefaults(); }
    setModelDefault(operation: import('@itookit/kernel-adapters/contracts').ModelOperation, id: string | null) { return this.llmService.setModelDefault(operation, id); }

    // ─── IAgentManagementService — Agent CRUD ─────────────────────────────────

    async saveAgent(agent: AgentDefinition, options?: { onDuplicate?: 'merge' | 'error' }): Promise<void> {
        await this.waitForLoad();
        const filename = `${agent.id}.agent`;
        const contentStr = JSON.stringify(agent, null, 2);
        const metadata = { icon: agent.icon || '🤖', title: agent.name, description: agent.description };

        const cachedId = this._agentNodeIds.get(agent.id);
        if (cachedId) {
            await this.engine.driver.writeContent(cachedId, contentStr);
            await this.engine.driver.updateMetadata(cachedId, metadata);
        } else {
            // Search for ALL existing files with this agent filename
            const query: FSSearchQuery = { name: { contains: filename }, type: 'file' };
            const results = await this.engine.driver.search(query);
            const allExisting = Array.from(results.nodes).filter((n: FSNode) => n.name === filename);

            if (allExisting.length > 1 && options?.onDuplicate === 'error') {
                const paths = allExisting.map(n => n.path).join(', ');
                throw new Error(
                    `Agent ID "${agent.id}" already exists at multiple paths: ${paths}. ` +
                    `Resolve duplicates before saving.`
                );
            }

            if (allExisting.length > 0) {
                // Pick canonical path (prefer /default/), update content, delete duplicates
                const canonical = allExisting.find(n => n.path.includes('/default/')) || allExisting[0];
                this._agentNodeIds.set(agent.id, canonical.path);
                await this.engine.driver.writeContent(canonical.path, contentStr);
                await this.engine.driver.updateMetadata(canonical.path, metadata);

                for (const dup of allExisting) {
                    if (dup.path !== canonical.path) {
                        try {
                            await this.engine.driver.delete([dup.path]);
                            this.host.logger.warn('Cleaned up duplicate agent file during save', {
                                agentId: agent.id, kept: canonical.path, removed: dup.path,
                            });
                        } catch (e) {
                            this.host.logger.error('Failed to delete duplicate agent file', { path: dup.path, error: e });
                        }
                    }
                }
            } else {
                // Create new — use /default/ directory, not module root
                const parentDir = AGENT_DEFAULT_DIR;
                await this.ensureDirectory(parentDir);
                const node = await this.engine.driver.createFile({
                    name: filename,
                    parentPath: parentDir,
                    content: contentStr,
                    metadata,
                });
                if (node?.path) this._agentNodeIds.set(agent.id, node.path);
            }
        }

        // Update in-memory list directly; suppress VFS event round-trip for local writes
        this.cancelPendingSync();
        const idx = this._agents.findIndex(a => a.id === agent.id);
        if (idx >= 0) {
            this._agents[idx] = { ...agent, tags: this._agents[idx].tags };
        } else {
            this._agents.push(agent);
        }
        this.notify();
    }

    async deleteAgent(agentId: string): Promise<void> {
        await this.waitForLoad();
        const cachedId = this._agentNodeIds.get(agentId);
        const filename = `${agentId}.agent`;

        // Delete cached node first, then search for any remaining duplicates
        if (cachedId) {
            await this.engine.driver.delete([cachedId]);
            this._agentNodeIds.delete(agentId);
        }

        // Also clean up any duplicate files with the same filename
        const query: FSSearchQuery = { name: { contains: filename }, type: 'file' };
        const results = await this.engine.driver.search(query);
        const allNodes = Array.from(results.nodes).filter((n: FSNode) => n.name === filename);
        for (const node of allNodes) {
            if (node.path !== cachedId) {
                try { await this.engine.driver.delete([node.path]); } catch { /* ignore */ }
            }
        }

        this._duplicatePaths.delete(agentId);
        this.cancelPendingSync();
        this._agents = this._agents.filter(a => a.id !== agentId);
        this.notify();
    }

    // ─── ILLMManagementService — 全部委托给 llmService（LLMDeviceDriver）─────

    getConfigVersion(): number { return this.llmService.getConfigVersion(); }
    getDefaultAgents(): InitialAgentDef[] { return this.llmService.getDefaultAgents(); }
    getDefaultConnections() { return this.llmService.getDefaultConnections(); }
    getProviderDefaults(): Record<string, LLMProvider> { return this.llmService.getProviderDefaults(); }
    getProvider(providerId: string): LLMProvider | undefined { return this.llmService.getProvider(providerId); }
    getProviders(): LLMProvider[] { return this.llmService.getProviders(); }
    getFullProvider(id: string): LLMProvider | undefined | Promise<LLMProvider | undefined> { return this.llmService.getFullProvider(id); }
    async saveProvider(provider: LLMProvider): Promise<void> { return this.llmService.saveProvider(provider); }
    async deleteProvider(id: string): Promise<void> { return this.llmService.deleteProvider(id); }
    async listProviderModels(provider: LLMProvider) { return this.llmService.listProviderModels(provider); }
    async testConnection(params: ProviderConnectionTestParams): Promise<ConnectionTestResult> { return this.llmService.testConnection(params); }
    async getProviderAuthorization(id: string) {
        return this.llmService.getProviderAuthorization?.(id) ?? { supported: false, status: 'signed-out' as const };
    }
    async beginProviderAuthorization(id: string) { return this.requireAuthorization().beginProviderAuthorization!(id); }
    async cancelProviderAuthorization(id: string) { return this.requireAuthorization().cancelProviderAuthorization!(id); }
    async disconnectProviderAuthorization(id: string) { return this.requireAuthorization().disconnectProviderAuthorization!(id); }
    async completeProviderAuthorization(id: string, attempt: string, callback: string) {
        return this.requireAuthorization().completeProviderAuthorization!(id, attempt, callback);
    }
    private requireAuthorization() {
        if (!this.llmService.beginProviderAuthorization) throw new Error('Provider authorization is unavailable');
        return this.llmService;
    }

    async getConnections(): Promise<ConnectionMeta[]> { return this.llmService.getConnections(); }
    async getFullConnection(id: string): Promise<LLMConnection | null> { return this.llmService.getFullConnection(id); }
    async saveConnection(conn: LLMConnection): Promise<void> { return this.llmService.saveConnection(conn); }
    async deleteConnection(id: string): Promise<void> { return this.llmService.deleteConnection(id); }

    async readMCPResource(id: string, uri: string) { return this.llmService.readMCPResource(id, uri); }
    async getMCPPrompt(id: string, name: string, args?: Record<string, string>) { return this.llmService.getMCPPrompt(id, name, args); }

    supportsMCPStdio(): boolean { return this.llmService.supportsMCPStdio?.() ?? false; }
    async testMCPServer(server: MCPServer) { return this.llmService.testMCPServer(server); }
    async getMCPServers(): Promise<MCPServer[]> { return this.llmService.getMCPServers(); }
    async saveMCPServer(server: MCPServer): Promise<void> { return this.llmService.saveMCPServer(server); }
    async deleteMCPServer(id: string): Promise<void> { return this.llmService.deleteMCPServer(id); }

    async getSkills(): Promise<LLMSkill[]> { return this.llmService.getSkills(); }
    async saveSkill(skill: LLMSkill): Promise<void> { return this.llmService.saveSkill(skill); }
    async deleteSkill(id: string): Promise<void> { return this.llmService.deleteSkill(id); }

    async recordCost(params: Parameters<ILLMManagementService['recordCost']>[0]): Promise<void> {
        return this.llmService.recordCost(params);
    }

    async writePricing(config: Parameters<ILLMManagementService['writePricing']>[0]): Promise<void> {
        return this.llmService.writePricing(config);
    }

    async queryCosts(filter?: Parameters<ILLMManagementService['queryCosts']>[0]): Promise<import('../contracts').CostRecord[]> {
        return this.llmService.queryCosts(filter);
    }

    getPricingConfig(): import('../contracts').ModelPricingConfig {
        return this.llmService.getPricingConfig();
    }

    getPricingDefaults(): import('../contracts').ModelPricingConfig {
        return this.llmService.getPricingDefaults();
    }

    // ─── Restore / Diagnose ───────────────────────────────────────────────────

    async getRestorableItems(): Promise<RestorableItem[]> {
        const connections = await this.getConnections();
        const connMap = new Map(connections.map(c => [c.id, c]));
        const providerDefaults = this.llmService.getProviderDefaults();
        const items: RestorableItem[] = [];

        // ── Layer 1: Providers ─────────────────────────────────────────────────
        for (const [key, def] of Object.entries(providerDefaults)) {
            const vfsProvider = await this.llmService.getFullProvider(key);
            const status: RestorableItem['status'] = !vfsProvider
                ? 'missing'
                : this.isProviderModified(vfsProvider, def)
                    ? 'modified'
                    : 'ok';
            items.push({
                id: key, type: 'provider', name: def.name,
                description: `${def.implementation} · ${def.baseURL || '自定义端点'}`,
                icon: (def as any).icon || '🏭', status,
            });
        }

        // ── Layer 2: Connections ───────────────────────────────────────────────
        for (const connDef of this.llmService.getDefaultConnections()) {
            const existing = connMap.get(connDef.id);
            const status: RestorableItem['status'] = !existing ? 'missing'
                : await this.isConnectionModified(existing, connDef) ? 'modified' : 'ok';
            const provider = providerDefaults[connDef.providerId];
            items.push({
                id: connDef.id, type: 'connection', name: connDef.name,
                description: `${connDef.name}（${provider?.name ?? connDef.providerId}）`,
                icon: (provider as any)?.icon || '🔗', status,
            });
        }

        // ── Layer 3: Agents ────────────────────────────────────────────────────
        const agentMap = new Map(this._agents.map(a => [a.id, a]));
        for (const def of this.llmService.getDefaultAgents()) {
            const existing = agentMap.get(def.id);
            const status: RestorableItem['status'] = !existing ? 'missing'
                : this.isAgentModified(existing, def) ? 'modified' : 'ok';
            const dupPaths = this._duplicatePaths.get(def.id);
            items.push({
                id: def.id, type: 'agent', name: def.name,
                description: def.description, icon: def.icon || '🤖', status,
                ...(dupPaths?.length ? { duplicatePaths: dupPaths } : {}),
            });
        }

        return items;
    }

    // ── Diff helpers ─────────────────────────────────────────────────────────

    private isProviderModified(current: LLMProvider, def: LLMProvider): boolean {
        if (current.name !== def.name) return true;
        if (current.baseURL !== def.baseURL) return true;
        if (current.defaultPath !== def.defaultPath) return true;
        if (current.anthropicPath !== def.anthropicPath) return true;
        if (current.enabled !== def.enabled) return true;
        // Compare model identity only. Full deep-equal is unreliable because
        // getFullProvider() returns models with pricing fields injected
        // (applyPricingToModel), which are absent from the built-in defaults.
        if (!deepEqual(current.models.map(m => m.id).sort(), def.models.map(m => m.id).sort())) return true;
        return false;
    }

    private async isConnectionModified(current: ConnectionMeta, def: DefaultConnectionDef): Promise<boolean> {
        if (current.name !== def.name) return true;
        if (current.providerId !== def.providerId) return true;
        // ConnectionMeta doesn't expose tiers/protocol,
        // so fetch full connection for deeper comparison
        const full = await this.llmService.getFullConnection(current.id);
        if (full) {
            if (!deepEqual(full.tiers, def.tiers)) return true;
            if (full.protocol !== def.protocol) return true;
        }
        return false;
    }

    private isAgentModified(current: AgentDefinition, def: InitialAgentDef): boolean {
        const expected = sharedPromptAgent(def);
        if (current.config.systemPromptId !== expected.config.systemPromptId) return true;
        if (current.name !== def.name) return true;
        if (current.config.systemPrompt !== expected.config.systemPrompt) return true;
        if (current.config.temperature !== def.config.temperature) return true;
        if (current.config.maxHistoryLength !== def.config.maxHistoryLength) return true;
        if (!deepEqual(current.defaultPrompts, expected.defaultPrompts)) return true;
        return false;
    }

    async restoreItem(type: 'provider' | 'connection' | 'agent', id: string): Promise<void> {
        if (type === 'provider')    await this.restoreProvider(id);
        else if (type === 'connection') await this.restoreConnection(id);
        else await this.restoreAgent(id);
    }

    async resetAllDefaults(): Promise<void> {
        // Scan and clean up any duplicate agent files before resetting
        await this.refreshData();
        if (this._duplicatePaths.size > 0) {
            const dupSummary = Array.from(this._duplicatePaths.entries()).map(
                ([id, paths]) => `${id}: [${paths.join(', ')}]`
            );
            this.host.logger.warn('Duplicate agent files cleaned before full reset', {
                count: this._duplicatePaths.size, details: dupSummary,
            });
        }

        // Reset providers (keep existing apiKey)
        const providerDefaults = this.llmService.getProviderDefaults();
        for (const id of Object.keys(providerDefaults)) {
            await this.restoreProvider(id);
        }
        // Reset connections
        for (const connDef of this.llmService.getDefaultConnections()) {
            await this.restoreConnection(connDef.id);
        }
        // Reset agents
        for (const def of this.llmService.getDefaultAgents()) {
            await this.restoreAgent(def.id);
        }
        // Reset pricing to built-in defaults
        await this.llmService.writePricing(this.llmService.getPricingDefaults());
    }

    private async restoreProvider(providerId: string): Promise<void> {
        const builtinDef = this.llmService.getProviderDefaults()[providerId];
        if (!builtinDef) throw new Error(`No built-in definition for provider: ${providerId}`);
        // Reset to built-in defaults, preserving user's apiKey
        const existing = await this.llmService.getFullProvider(providerId);
        await this.saveProvider({
            ...builtinDef,
            id: providerId,
            isBuiltin: true,
            apiKey: existing?.apiKey,  // preserve user's apiKey
        });
    }

    private async restoreConnection(targetId: string): Promise<void> {
        const connDef = this.llmService.getDefaultConnections().find(c => c.id === targetId);
        if (!connDef) throw new Error(`No default definition for connection id: ${targetId}`);
        await this.saveConnection({
            id: connDef.id,
            name: connDef.name,
            providerId: connDef.providerId,
            tiers: connDef.tiers,
            metadata: { isSystemDefault: true },
        });
    }

    private async restoreAgent(agentId: string): Promise<void> {
        const def = this.llmService.getDefaultAgents().find(a => a.id === agentId);
        if (!def) throw new Error(`No default definition for agent id: ${agentId}`);
        const { initPath, initialTags, ...agentData } = def;
        if (def.config.systemPrompt && !await this.getSystemPrompt(def.id)) await this.saveSystemPrompt(defaultPrompt(def));
        await this.saveAgent(sharedPromptAgent(agentData as AgentDefinition));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private async scanAgentFiles(): Promise<AgentDefinition[]> {
        const agents: AgentDefinition[] = [];
        this._agentNodeIds.clear();
        this._duplicatePaths.clear();
        try {
            const result = await this.engine.driver.search({ name: { contains: '.agent' }, type: 'file' });

            const scanned = await Promise.all(Array.from(result.nodes).map(async (node) => {
                if (!node.name.endsWith('.agent')) return null;
                try {
                    const content = await this.engine.driver.readContent(node.path, { representation: 'bytes' });
                    if (!content) return null;
                    const jsonStr = typeof content === 'string' ? content : new TextDecoder().decode(content as ArrayBuffer);
                    const data = JSON.parse(jsonStr) as AgentDefinition;
                    if (data.id) {
                        return { ...data, tags: node.tags, _scanPath: node.path } as AgentDefinition & { _scanPath: string };
                    }
                    return null;
                } catch { return null; }
            }));

            // Group by agent ID, detect and clean up duplicates
            const byId = new Map<string, Array<AgentDefinition & { _scanPath: string }>>();
            for (const item of scanned) {
                if (!item) continue;
                const group = byId.get(item.id) || [];
                group.push(item);
                byId.set(item.id, group);
            }

            for (const [agentId, group] of byId) {
                const { _scanPath, ...clean } = group[0];
                if (group.length === 1) {
                    this._agentNodeIds.set(agentId, _scanPath);
                    agents.push(clean);
                } else {
                    // Duplicates detected: prefer /default/ path, delete others
                    const defaultItem = group.find(g => g._scanPath.includes('/default/')) || group[0];
                    const duplicates = group.filter(g => g !== defaultItem);

                    const { _scanPath: _sp, ...canonical } = defaultItem;
                    this._agentNodeIds.set(agentId, _sp);
                    agents.push(canonical);

                    const dupPaths = duplicates.map(d => d._scanPath);
                    this._duplicatePaths.set(agentId, dupPaths);

                    this.host.logger.warn('Duplicate agent files detected — merging', {
                        agentId, kept: _sp, removed: dupPaths,
                    });

                    // Delete duplicate files
                    for (const dup of duplicates) {
                        try {
                            await this.engine.driver.delete([dup._scanPath]);
                        } catch (e) {
                            this.host.logger.error('Failed to delete duplicate agent file', {
                                path: dup._scanPath, error: e,
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[VFSAgentService] Failed to scan agents:', e);
        }
        return agents;
    }

    async dispose(): Promise<void> {
        await super.dispose();
        this._eventUnsubscribers.forEach(fn => fn());
        this._eventUnsubscribers = [];
        if (this._syncTimer) { clearTimeout(this._syncTimer); this._syncTimer = null; }
        this._agentNodeIds.clear();
        this._duplicatePaths.clear();
    }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

/** Shallow-enough deep equal for config objects (JSON-serializable values). */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a == b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
}


/** New built-in Agents reference the separately seeded prompt library. */
function sharedPromptAgent(agent: AgentDefinition): AgentDefinition {
    if (!agent.config.systemPrompt) return agent;
    return { ...agent, defaultPrompts: undefined,
        config: { ...agent.config, systemPromptId: agent.id, systemPrompt: undefined } };
}
function assertPromptId(id: string): void {
    if (!id?.trim() || id === '.' || id === '..' || /[/\\\x00]/.test(id)) throw new Error('Invalid system prompt id');
}

function defaultPrompt(agent: AgentDefinition): SystemPromptDefinition {
    return { id: agent.id, name: agent.name, description: agent.description,
        content: agent.config.systemPrompt ? [agent.config.systemPrompt] : [],
        ...(agent.defaultPrompts?.length ? { presets: agent.defaultPrompts } : {}) };
}
