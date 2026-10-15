import { toolGrant, saveToolGrant, type ToolGrantTarget } from './tool-grants';
import { ToolboxDrawers, drawerKind, ungroupedId, type Drawer, type DrawerKind } from './toolbox-drawers';
import { randomUUID, t } from '@itookit/common';
import { type SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import { mcpConfiguration, type MCPServer } from '@itookit/tools/mcp-contracts';
import { type LLMProvider, type LLMConnection } from '@itookit/driver-llm/contracts';
import { type AgentDefinition, type LLMSkill } from '@itookit/kernel-adapters/contracts';
import { type ICommandBus } from '@itookit/llm-session/contracts';
import { type FlowDraft } from '@itookit/llm-flow/contracts';
import { FlowCommand } from '@itookit/llm-session';
import type { ApplicationAgentPort } from '@itookit/app-contracts/services';
import type { IFileSystem } from '@itookit/vfs-core';
import { toolboxPath, type ToolboxKind } from './toolbox-identity';

/** Resource creation retains the owning services' identity and validation rules. */
export class ToolboxResources {
    readonly drawers: ToolboxDrawers;
    constructor(readonly sources: Record<ToolboxKind, IFileSystem>, private readonly agents: ApplicationAgentPort, private readonly commands: ICommandBus, settings: IFileSystem) { this.drawers = new ToolboxDrawers(settings); }
    subscribe(listener: () => void): () => void { return this.agents.onChange(listener); }
    setDefaultConnection(id: string | null): Promise<void> { return this.agents.setDefaultConnection(id); }
    toolGrant = toolGrant;
    getAgents(): Promise<AgentDefinition[]> { return this.agents.getAgents(); }
    hasProvider(id: string): boolean { return this.agents.getProviders().some(item => item.id === id); }
    setToolGrant(tool: ToolGrantTarget, agentId: string, enabled: boolean): Promise<void> { return saveToolGrant(this.agents, tool, agentId, enabled); }
    async refreshGroups(toolGroups: readonly Drawer[]): Promise<void> {
        const defaults: Drawer[] = [...toolGroups], resources: Array<{ path: string; kind: DrawerKind; groupId?: string }> = [];
        for (const group of toolGroups) for (const path of group.paths) resources.push({ path, kind: 'tools', groupId: group.id });
        for (const skill of await this.agents.getSkills()) resources.push({ path: toolboxPath('skills', '/' + skill.id), kind: 'skills' });
        for (const kind of ['agents', 'flows', 'prompts', 'mcp'] as const) await this.scanGroups(kind, '/', defaults, resources);
        this.drawers.setCatalog(resources, defaults);
    }
    private async scanGroups(kind: DrawerKind, parent: string, groups: Drawer[], resources: Array<{ path: string; kind: DrawerKind; groupId?: string }>, group?: Drawer): Promise<void> {
        for (const node of await this.sources[kind].driver.getChildren(parent)) {
            if (node.name.startsWith('.') || node.name === 'system-prompts') continue;
            const path = toolboxPath(kind, node.path);
            if (node.type === 'file') {
                if (kind !== 'agents' || node.path.endsWith('.agent')) resources.push({ path, kind, groupId: group?.id });
            } else {
                if (kind === 'agents' && node.path === '/default') { await this.scanGroups(kind, node.path, groups, resources); continue; }
                const name = String(node.metadata?.title ?? node.name);
                const next: Drawer = { id: '/drawers/legacy-' + encodeURIComponent(path), kind, name: group ? group.name + ' / ' + name : name, paths: [] };
                groups.push(next); await this.scanGroups(kind, node.path, groups, resources, next);
            }
        }
    }
    async create(kind: ToolboxKind, name: string, providerId?: string): Promise<string> {
        if (!name.trim()) throw new Error(t('toolbox.nameRequired'));
        name = name.trim();
        if (kind === 'tools') throw new Error(t('toolbox.toolsCreate'));
        const id = randomUUID();
        if (kind === 'providers' || kind === 'connections') return this.createModel(kind, id, name, providerId);
        if (kind === 'prompts') {
            await this.agents.saveSystemPrompt({ id, name, content: [] });
            return toolboxPath(kind, '/' + id);
        }
        if (kind === 'mcp') {
            await this.agents.saveMCPServer({ id, name, transport: 'http', status: 'idle' });
            return toolboxPath(kind, '/' + id);
        }
        if (kind === 'agents') {
            await this.agents.saveAgent({ id, name, type: 'agent', description: '', config: {} });
            return toolboxPath(kind, this.agents.getAgentResourceId(id)!);
        }
        if (kind === 'flows') {
            await this.commands.execute(FlowCommand.DraftCreate, { id, name });
            return toolboxPath(kind, '/' + id + '.flow');
        }
        const now = Date.now();
        await this.agents.saveSkill({ id, name, type: 'prompt', enabled: false, description: '', instructions: '', tools: [],
            triggerPatterns: [], autoLoad: false, priority: 50, createdAt: now, modifiedAt: now });
        return toolboxPath(kind, '/' + id);
    }
    async createInDrawer(kind: ToolboxKind, name: string, drawer: string, providerId?: string): Promise<string> {
        const path = await this.create(kind, name, providerId);
        if (kind === 'providers' || kind === 'connections') return path;
        try { await this.drawers.assign([{ path, name: drawer }]); return path; }
        catch (error) {
            try {
                if (kind === 'prompts') await this.agents.deleteSystemPrompt(path.split('/').pop()!);
                else if (kind === 'skills') await this.agents.deleteSkill(path.split('/').pop()!);
                    else if (kind === 'mcp') await this.agents.deleteMCPServer(path.split('/').pop()!);
                else await this.sources[kind].driver.delete([path.slice(kind.length + 1)]);
            } catch (cleanup) { throw new AggregateError([error, cleanup], 'Resource creation and cleanup failed'); }
            throw error;
        }
    }
    private async createModel(kind: 'providers' | 'connections', id: string, name: string, selectedProvider?: string): Promise<string> {
        if (kind === 'providers') await this.agents.saveProvider({ id, name, implementation: 'openai-compatible', baseURL: '', models: [], isBuiltin: false });
        else {
            const providerId = selectedProvider ?? this.agents.getProviders()[0]?.id;
            if (!providerId || !this.agents.getProviders().some(provider => provider.id === providerId)) throw new Error(t('toolbox.providerRequired'));
            await this.agents.saveConnection({ id, name, providerId });
        }
        return toolboxPath(kind, '/' + encodeURIComponent(id));
    }
    async descriptions(): Promise<Map<string, { name: string; description?: string }>> {
        const [agents, skills, flows] = await Promise.all([this.agents.getAgents(), this.agents.getSkills(),
            this.commands.execute<FlowDraft[]>(FlowCommand.DraftList, {})]);
        const map = new Map<string, { name: string; description?: string }>();
        for (const item of agents) map.set('agents/' + item.id, item);
        for (const item of skills) map.set('skills/' + item.id, item);
        for (const item of flows) map.set('flows/' + item.id, item);
        return map;
    }
    async export(paths: string[], drawers: Array<{ kind: DrawerKind; name: string }> = []): Promise<string> {
        const entries = [];
        const queue = [...new Set(paths)];
        for (const path of queue) {
            const kind = path.split('/')[1] as ToolboxKind, source = this.sources[kind], local = path.slice(kind.length + 1);
            if (!source || kind !== 'prompts' && kind !== 'skills' && (await source.driver.getNode(local))?.type !== 'file') throw new Error(t('toolbox.selectFiles'));
            const data = kind === 'providers' ? await this.agents.getFullProvider(decodeURIComponent(local.slice(1)))
                : kind === 'prompts' ? await this.agents.getSystemPrompt(decodeURIComponent(local.slice(1)))
                : kind === 'connections' ? await this.agents.getFullConnection(decodeURIComponent(local.slice(1)))
                : kind === 'mcp' ? (await this.agents.getMCPServers()).find(item => item.id === decodeURIComponent(local.slice(1))) : kind === 'skills' ? (await this.agents.getSkills()).find(item => item.id === local.slice(1))
                : JSON.parse(await source.driver.readContent(local, { encoding: 'utf-8' }));
            if (!data) throw new Error(t('toolbox.resourceMissing'));
            for (const id of promptIds(kind, data)) {
                const dependency = toolboxPath('prompts', '/' + encodeURIComponent(id));
                if (!queue.includes(dependency)) queue.push(dependency);
            }
            const group = this.drawers.forPath(path);
            entries.push({ kind, data: kind === 'mcp' ? mcpConfiguration(data as MCPServer) : data, drawer: group && group.id === ungroupedId(group.kind) ? '' : group?.name });
        }
        return JSON.stringify({ format: 'itookit.toolbox', version: 1, entries, drawers }, null, 2);
    }
    async import(content: string): Promise<string[]> {
        const archive = JSON.parse(content);
        if (archive?.format !== 'itookit.toolbox' || archive.version !== 1 || !Array.isArray(archive.entries)) throw new Error(t('toolbox.importInvalid'));
        for (const entry of archive.entries) {
            validateEntry(entry);
            if (entry.drawer !== undefined && typeof entry.drawer !== 'string') throw new Error(t('toolbox.importInvalid'));
            if (entry.kind === 'tools') await this.toolReference(entry.data.id);
        }
        const drawers = archive.drawers ?? [];
        if (!Array.isArray(drawers) || drawers.some(group => !group || !drawerKind(group.kind) || typeof group.name !== 'string' || !group.name.trim())) throw new Error(t('toolbox.importInvalid'));
        const plan = planImport(archive.entries);
        const created: string[] = [];
        try {
            for (const entry of plan) created.push(await this.importEntry(entry.kind, entry.data, entry.id));
            const grouped = plan.flatMap((entry, index) => entry.drawer === undefined ? [] : [{ path: created[index], name: entry.drawer }]);
            if (grouped.length || drawers.length) await this.drawers.assign(grouped, drawers, { restoreNames: true });
            return created;
        } catch (error) {
            const errors = [error];
            for (const path of created.reverse()) {
                const kind = path.split('/')[1] as ToolboxKind;
                try { if (kind === 'tools') continue;
                    if (kind === 'providers') await this.agents.deleteProvider(decodeURIComponent(path.split('/').pop()!));
                    else if (kind === 'connections') await this.agents.deleteConnection(decodeURIComponent(path.split('/').pop()!));
                    else if (kind === 'prompts') await this.agents.deleteSystemPrompt(decodeURIComponent(path.split('/').pop()!));
                    else if (kind === 'skills') await this.agents.deleteSkill(path.split('/').pop()!);
                    else if (kind === 'mcp') await this.agents.deleteMCPServer(decodeURIComponent(path.split('/').pop()!)); else await this.sources[kind].driver.delete([path.slice(kind.length + 1)]); } catch (cleanup) { errors.push(cleanup); }
            }
            if (errors.length > 1) throw new AggregateError(errors, 'Toolbox import and cleanup failed');
            throw error;
        }
    }
    private async toolReference(id: string): Promise<string> {
        const local = '/' + encodeURIComponent(id);
        if (!await this.sources.tools.driver.exists(local)) throw new Error(t('toolbox.toolSourceMissing'));
        return toolboxPath('tools', local);
    }
    private async importEntry(kind: ToolboxKind, data: ToolboxDefinition, id: string): Promise<string> {
        if (kind === 'tools') return this.toolReference(data.id);
        if (kind === 'prompts') {
            await this.agents.saveSystemPrompt({ ...data as SystemPromptDefinition, id });
            return toolboxPath(kind, '/' + id);
        }
        if (kind === 'providers' || kind === 'connections') return this.importModel(kind, data, id);
        if (kind === 'mcp') {
            await this.agents.saveMCPServer({ ...data as MCPServer, id, status: 'idle', tools: [], resources: [], prompts: [] });
            return toolboxPath(kind, '/' + id);
        }
        if (kind === 'agents') {
            await this.agents.saveAgent({ ...data as AgentDefinition, id });
            return toolboxPath(kind, this.agents.getAgentResourceId(id)!);
        }
        if (kind === 'skills') {
            await this.agents.saveSkill({ ...data as LLMSkill, id, createdAt: Date.now(), modifiedAt: Date.now() });
            return toolboxPath(kind, '/' + id);
        }
        return this.importFlow(data as FlowDraft, id);
    }
    private async importModel(kind: 'providers' | 'connections', data: ToolboxDefinition, id: string): Promise<string> {
        if (kind === 'providers') await this.agents.saveProvider({ ...data as LLMProvider, id, isBuiltin: false });
        else {
            const connection = data as LLMConnection;
            await this.agents.saveConnection({ ...connection, id, metadata: { ...connection.metadata, isSystemDefault: false } });
        }
        return toolboxPath(kind, '/' + encodeURIComponent(id));
    }
    private async importFlow(data: FlowDraft, id: string): Promise<string> {
        const created = await this.commands.execute<FlowDraft>(FlowCommand.DraftCreate, { id, name: data.name });
        const draft = { ...data, id, baseRevision: undefined, draftVersion: created.draftVersion, updatedAt: Date.now() };
        try {
            await this.commands.execute(FlowCommand.DraftSave, { draft, expectedDraftVersion: created.draftVersion });
        } catch (error) {
            await this.sources.flows.driver.delete(['/' + id + '.flow']); throw error;
        }
        return toolboxPath('flows', '/' + id + '.flow');
    }
}
function validateEntry(entry: { kind?: string; data?: Record<string, unknown> }): void {
    const data = entry?.data;
    if (!data || typeof data.name !== 'string' || !data.name.trim()) throw new Error(t('toolbox.importInvalid'));
    if (entry.kind === 'prompts' && typeof data.id === 'string' && Array.isArray(data.content) && data.content.every(value => typeof value === 'string')
        && (data.presets === undefined || Array.isArray(data.presets) && data.presets.every(value => value && typeof value.name === 'string' && typeof value.prompt === 'string'))) return;
    if (entry.kind === 'providers' && typeof data.implementation === 'string' && Array.isArray(data.models)) return;
    if (entry.kind === 'connections' && typeof data.providerId === 'string') return;
    if (entry.kind === 'tools' && typeof data.id === 'string') return;
    if (entry.kind === 'agents' && data.type === 'agent' && data.config && typeof data.config === 'object') return;
    if (entry.kind === 'skills' && typeof data.instructions === 'string' && typeof data.enabled === 'boolean'
        && Array.isArray(data.tools) && Array.isArray(data.triggerPatterns) && typeof data.autoLoad === 'boolean' && typeof data.priority === 'number'
        && ['builtin', 'http', 'shell', 'prompt', 'mcp', 'custom'].includes(String(data.type))) return;
    if (entry.kind === 'mcp' && ['http', 'stdio'].includes(String(data.transport))) return;
    if (entry.kind === 'flows' && Array.isArray(data.nodes) && Array.isArray(data.edges)) return;
    throw new Error(t('toolbox.importInvalid'));
}

type ToolboxDefinition = SystemPromptDefinition | AgentDefinition | LLMSkill | FlowDraft | MCPServer | LLMProvider | LLMConnection;
function planImport(entries: Array<{ kind: ToolboxKind; data: ToolboxDefinition; drawer?: string }>) {
    const plan = entries.map(entry => ({ ...entry, id: randomUUID() }));
    const replacements = new Map(plan.map(entry => [entry.kind + '/' + entry.data.id, entry.id]));
    for (const entry of plan) {
        if (entry.kind === 'agents' || entry.kind === 'flows') {
            entry.data = structuredClone(entry.data);
            rewritePromptReferences(entry.kind, entry.data, id => replacements.get('prompts/' + id) ?? id);
        }
        if (entry.kind === 'connections') {
            const connection = entry.data as LLMConnection;
            entry.data = { ...connection, providerId: replacements.get('providers/' + connection.providerId) ?? connection.providerId };
        }
    }
    const rank = (kind: ToolboxKind) => kind === 'providers' || kind === 'prompts' ? 0 : kind === 'connections' ? 1 : 2;
    return plan.sort((a, b) => rank(a.kind) - rank(b.kind));
}


function rewritePromptReferences(kind: ToolboxKind, data: ToolboxDefinition, resolve: (id: string) => string): void {
    const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const item = value as Record<string, unknown>;
        if (typeof item.systemPromptId === 'string') item.systemPromptId = resolve(item.systemPromptId);
        for (const child of Object.values(item)) visit(child);
    };
    if (kind === 'agents') visit((data as AgentDefinition).config);
    if (kind === 'flows') { visit((data as FlowDraft).defaults); for (const node of (data as FlowDraft).nodes) visit(node.config); }
}
function promptIds(kind: ToolboxKind, data: ToolboxDefinition): string[] {
    const ids: string[] = [];
    rewritePromptReferences(kind, structuredClone(data), id => { ids.push(id); return id; });
    return ids;
}
