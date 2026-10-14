import type { MemoryPolicy } from '@itookit/llm-tasks/contracts';
import type { IAgentConfigService } from '../services/agent-service';
import { SessionMemoryProvider, type MemoryWrite, type MemoryMutationOptions } from './session-memory-provider';
import { MemorySharingControls } from './memory-sharing-controls';

/** Host management facade: callers select an Agent, never supply its authorization policy. */
export class SessionMemoryControls {
    readonly sharing: MemorySharingControls;
    constructor(private readonly provider: SessionMemoryProvider,
        private readonly agents: IAgentConfigService,
        private readonly sessionId: () => string,
        private readonly canWrite?: (sessionId: string) => Promise<boolean>) {
        this.sharing = new MemorySharingControls(provider, agents, sessionId, canWrite);
    }

    /** Pin a management view to its Session for its entire lifetime. */
    forSession(sessionId: string): SessionMemoryControls {
        return new SessionMemoryControls(this.provider, this.agents, () => sessionId, this.canWrite);
    }

    async list(agentId: string) {
        const sessionId = this.sessionId();
        return this.provider.list(sessionId, await this.policy(agentId));
    }

    async upsert(agentId: string, entry: MemoryWrite, options: MemoryMutationOptions = {}): Promise<void> {
        const sessionId = this.sessionId();
        entry = structuredClone(entry); options = structuredClone(options);
        const policy = await this.policy(agentId);
        await this.requireWritable(sessionId);
        await this.provider.upsert(sessionId, policy, entry, options);
    }

    async remove(agentId: string, scope: string, entryId: string, options: MemoryMutationOptions = {}): Promise<void> {
        const sessionId = this.sessionId();
        options = structuredClone(options);
        const policy = await this.policy(agentId);
        await this.requireWritable(sessionId);
        await this.provider.remove(sessionId, policy, scope, entryId, options);
    }

    private async policy(agentId: string): Promise<MemoryPolicy> {
        const definition = await this.agents.getAgentConfig(agentId);
        if (!definition || definition.id !== agentId || !definition.memoryPolicy) {
            throw new Error('Selected Agent has no memory policy');
        }
        return structuredClone(definition.memoryPolicy);
    }

    private async requireWritable(sessionId: string): Promise<void> {
        if (this.canWrite && !await this.canWrite(sessionId)) {
            throw new Error('Session is owned by another host; this host can only read it');
        }
    }
}
