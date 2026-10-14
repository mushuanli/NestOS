import type { IAgentConfigService, IAgentManagementService } from '../contracts';
import type { MemoryPolicy } from '@itookit/llm-tasks/contracts';
import type { SessionMemoryProvider } from './session-memory-provider';

type Reference = NonNullable<MemoryPolicy['sharedMemory']>;

/** Host administration only; never registered as model tools. */
export class MemorySharingControls {
    constructor(private readonly memory: SessionMemoryProvider, private readonly agents: IAgentConfigService,
        private readonly sessionId: () => string, private readonly canWrite?: (id: string) => Promise<boolean>) {}

    async state(agentId: string) {
        const policy = await this.policy(agentId);
        return { policy, sessionId: this.sessionId(), resources: (await this.store().list()).filter(item => item.namespaceId === policy.namespaceId) };
    }

    async create(agentId: string, id: string): Promise<Reference> {
        const sessionId = this.sessionId();
        await this.writable(sessionId);
        const policy = await this.policy(agentId);
        const resource = await this.store().create(id, policy.namespaceId, sessionId);
        await this.store().grant(resource, sessionId, { readScopes: policy.readScopes, writeScopes: policy.writeScopes }, resource.revision);
        return { id: resource.id, incarnation: resource.incarnation };
    }

    async use(agentId: string, ref: Reference | null): Promise<void> {
        await this.writable(this.sessionId());
        const agent = await this.agents.getAgentConfig(agentId);
        const policy = await this.policy(agentId);
        if (ref && (await this.store().inspect(ref)).namespaceId !== policy.namespaceId) throw new Error('Shared Memory namespace mismatch');
        const management = this.agents as IAgentConfigService & Partial<Pick<IAgentManagementService, 'saveAgent'>>;
        if (!management.saveAgent) throw new Error('Agent settings are read-only in this host');
        const { sharedMemory: _previous, ...local } = policy;
        await management.saveAgent({ ...agent!, memoryPolicy: { ...local, ...(ref ? { sharedMemory: { id: ref.id, incarnation: ref.incarnation } } : {}) } });
    }

    async grant(agentId: string, targetSessionId: string, writable: boolean): Promise<void> {
        await this.writable(this.sessionId());
        const policy = await this.policy(agentId);
        if (!policy.sharedMemory) throw new Error('Select a shared Memory resource first');
        const resource = await this.store().inspect(policy.sharedMemory);
        await this.store().grant(resource, targetSessionId, { readScopes: policy.readScopes, writeScopes: writable ? policy.writeScopes : [] }, resource.revision);
    }

    async revoke(agentId: string, targetSessionId: string): Promise<void> {
        await this.writable(this.sessionId());
        const resource = await this.selected(agentId);
        await this.store().grant(resource, targetSessionId, null, resource.revision);
    }

    async remove(agentId: string): Promise<void> {
        await this.writable(this.sessionId());
        const resource = await this.selected(agentId);
        await this.store().remove(resource, resource.revision);
    }

    async audit(agentId: string) { return this.store().history(await this.selected(agentId)); }

    private async selected(agentId: string) {
        const ref = (await this.policy(agentId)).sharedMemory;
        if (!ref) throw new Error('Select a shared Memory resource first');
        return this.store().inspect(ref);
    }

    private async policy(agentId: string): Promise<MemoryPolicy> {
        const agent = await this.agents.getAgentConfig(agentId);
        if (!agent?.memoryPolicy || agent.id !== agentId) throw new Error('Selected Agent has no memory policy');
        return structuredClone(agent.memoryPolicy);
    }

    private store() {
        if (!this.memory.shared) throw new Error('Shared Memory is not configured in this host');
        return this.memory.shared;
    }

    private async writable(sessionId: string) {
        if (this.canWrite && !await this.canWrite(sessionId)) throw new Error('Session is owned by another host');
    }
}
