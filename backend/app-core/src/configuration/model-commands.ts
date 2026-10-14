import { randomUUID } from '@itookit/common';
import { type ConnectionMeta, type LLMProvider } from '@itookit/driver-llm/contracts';
import { type IConnectionService } from '@itookit/kernel-adapters/contracts';
import { FSError } from '@itookit/vfs-core';
import { mcpConfiguration, type MCPServer } from '@itookit/tools/mcp-contracts';

export interface ConfigurationStore extends Pick<IConnectionService, 'getProviders' | 'getConnections' | 'deleteProvider' | 'deleteConnection'> {
    deleteSystemPrompt(id: string): Promise<void>;
    deleteMCPServer(id: string): Promise<void>;
    getMCPServers?(): Promise<unknown[]>;
}
export interface MCPDeletionReference { connectionId: string; projectId: string; mountId: string; at: string; revision: number; }
export interface MCPDeletedProject { id: string; name: string; path: string; localSessions: Array<{id: string; title: string}>; }
export interface MCPDeletionImpact { revision: string; ids: string[]; servers: Array<{id: string; name: string}>; references: MCPDeletionReference[]; projects: MCPDeletedProject[]; }
export interface MCPDeletionPort {
    reconcileMCPReferences?(): Promise<void>;
    mcpReferences(ids: readonly string[]): MCPDeletionReference[];
    inspectRemoteProjects?(ids: readonly string[]): Promise<MCPDeletedProject[]>;
    removeMCPReferences(ids: readonly string[], expected: readonly MCPDeletionReference[], projectIds?: readonly string[]): Promise<void>;
}
export interface ProviderDeletionImpact {
    revision: string;
    providers: LLMProvider[];
    connections: ConnectionMeta[];
}
export interface ConfigurationDeletionTarget { kind: 'providers' | 'connections' | 'mcp' | 'prompts'; ids: readonly string[] }
export class ConfigurationMutationError extends Error {
    constructor(readonly completed: readonly string[], cause: unknown) {
        super(`Configuration update incomplete; completed: ${completed.join(', ') || 'none'}. ${String(cause)}`, { cause });
    }
}

/** Cross-resource operations are shared by every host; UI only chooses a policy. */
export class ModelConfigurationCommands {
    mcpDeletion?: MCPDeletionPort;
    private readonly mcpPlans = new Map<string, { ids: string[]; signature: string }>();
    private readonly plans = new Map<string, { ids: string[]; signature: string }>();
    private closed = false;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly store: ConfigurationStore) {}
    private async impact(ids: readonly string[]): Promise<Omit<ProviderDeletionImpact, 'revision'>> {
        const providers = this.store.getProviders().filter(item => ids.includes(item.id));
        if (providers.length !== new Set(ids).size) throw new FSError('ENOENT', 'Provider not found');
        const all = await this.store.getConnections(), connections = all.filter(item => ids.includes(item.providerId));
        return { providers, connections };
    }
    async inspectProviderDeletion(ids: readonly string[]): Promise<ProviderDeletionImpact> {
        if (this.closed) throw new FSError('EBUSY', 'Configuration service is closed');
        const impact = await this.impact(ids), revision = randomUUID();
        this.plans.set(revision, { ids: [...new Set(ids)], signature: signature(impact) });
        return { ...impact, revision };
    }
    discardPlan(revision: string): void { this.plans.delete(revision); this.mcpPlans.delete(revision); }
    private async mcpImpact(ids: string[]): Promise<{references: MCPDeletionReference[]; projects: MCPDeletedProject[]; servers: Array<{id: string; name: string}>; signature: string}> {
        await this.mcpDeletion?.reconcileMCPReferences?.();
        const references = this.mcpDeletion?.mcpReferences(ids) ?? [];
        const roots = [...new Set(references.filter(ref => ref.at === '/').map(ref => ref.projectId))];
        const projects = await this.mcpDeletion?.inspectRemoteProjects?.(roots) ?? [];
        const servers = (await this.store.getMCPServers?.() ?? []).filter(server => !!server && typeof server === 'object' && 'id' in server && ids.includes(String(server.id)));
        const names = servers.map(server => { const value = server as {id: string; name?: string}; return {id:value.id,name:value.name ?? ''}; });
        return {references,projects,servers:names,signature:JSON.stringify([servers.map(server => mcpConfiguration(server as MCPServer)),references,projects])};
    }
    async inspectMCPDeletion(ids: readonly string[]): Promise<MCPDeletionImpact> {
        if (this.closed) throw new FSError('EBUSY', 'Configuration service is closed');
        const selected = [...new Set(ids)], impact = await this.mcpImpact(selected), revision = randomUUID();
        this.mcpPlans.set(revision,{ids:selected,signature:impact.signature});
        return {revision,ids:selected,servers:structuredClone(impact.servers),references:structuredClone(impact.references),projects:structuredClone(impact.projects)};
    }
    deleteMCPServers(input: {revision: string; force: boolean}): Promise<void> {
        return this.serial(async () => {
            const plan = this.mcpPlans.get(input.revision);
            if (!plan) throw new FSError('EINVAL', 'Deletion preview expired');
            const impact = await this.mcpImpact(plan.ids);
            if (impact.signature !== plan.signature) throw new FSError('EBUSY', 'Configuration changed; review deletion again');
            if (impact.references.length && !input.force) throw new FSError('EBUSY', 'Confirm removal of remote project references');
            if (impact.references.length) await this.mcpDeletion!.removeMCPReferences(plan.ids,impact.references,impact.projects.map(project => project.id));
            this.mcpPlans.delete(input.revision);
            const completed: string[] = [...impact.references.map(ref => `mount:${ref.projectId}:${ref.mountId}`),...impact.projects.map(project => `project:${project.id}`)];
            try { for (const id of plan.ids) { await this.store.deleteMCPServer(id); completed.push(`mcp:${id}`); } }
            catch (error) { throw new ConfigurationMutationError(completed,error); }
        });
    }
    deleteProviders(input: { revision: string }): Promise<void> {
        return this.serial(async () => {
            const plan = this.plans.get(input.revision);
            if (!plan) throw new FSError('EINVAL', 'Deletion preview expired');
            const impact = await this.impact(plan.ids);
            if (signature(impact) !== plan.signature) throw new FSError('EBUSY', 'Configuration changed; review deletion again');
            this.plans.delete(input.revision);
            await this.applyDeletion(impact);
        });
    }
    private async applyDeletion(impact: Omit<ProviderDeletionImpact, 'revision'>): Promise<void> {
        const completed: string[] = [];
        try {
            for (const item of impact.connections) { await this.store.deleteConnection(item.id); completed.push(`connection:${item.id}`); }
            for (const item of impact.providers) { await this.store.deleteProvider(item.id); completed.push(`provider:${item.id}`); }
        } catch (error) { throw new ConfigurationMutationError(completed, error); }
    }
    deleteResources(target: { kind: 'connections' | 'mcp' | 'prompts'; ids: readonly string[] }): Promise<void> {
        return this.serial(async () => {
            const completed: string[] = [];
            try {
                for (const id of new Set(target.ids)) {
                    if (target.kind === 'prompts') await this.store.deleteSystemPrompt(id);
                    else if (target.kind === 'connections') await this.store.deleteConnection(id); else await this.store.deleteMCPServer(id);
                    completed.push(`${target.kind}:${id}`);
                }
            } catch (error) { throw new ConfigurationMutationError(completed, error); }
        });
    }
    async dispose(): Promise<void> { this.closed = true; await this.tail; this.plans.clear(); this.mcpPlans.clear(); }
    private serial(work: () => Promise<void>): Promise<void> {
        if (this.closed) return Promise.reject(new FSError('EBUSY', 'Configuration service is closed'));
        const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
    }
}
function signature(impact: Omit<ProviderDeletionImpact, 'revision'>): string {
    return JSON.stringify({ providers: impact.providers.map(item => item.id).sort(),
        connections: impact.connections.map(item => [item.id, item.providerId]).sort() });
}
