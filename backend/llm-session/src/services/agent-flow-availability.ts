import type { AgentAvailability, AgentDefinition, AgentExecution } from '@itookit/kernel-adapters/contracts';
import type { SessionLogger } from '../utils/host-ports';
import { ulid } from '../persistence/ulid';

export interface AgentFlowAvailabilitySource {
    inspect(execution: Extract<AgentExecution, { kind: 'flow' }>): Promise<AgentAvailability>;
    subscribe(listener: () => void): () => void;
}

/** Availability is an observation; source configuration remains untouched. */
export class AgentFlowAvailabilityProjection {
    private source?: AgentFlowAvailabilitySource;
    private stop?: () => void;
    private values = new Map<string, AgentAvailability>();
    private pending = new Map<string, Promise<void>>();
    private generation = 0;
    constructor(private readonly logger: SessionLogger) {}
    configure(source: AgentFlowAvailabilitySource, changed: () => void): void {
        this.stop?.(); this.invalidate(); this.source = source;
        this.stop = source.subscribe(() => { this.invalidate(); changed(); });
    }
    invalidate(): void { this.generation++; this.pending.clear(); this.values.clear(); }
    async refresh(agents: AgentDefinition[]): Promise<void> {
        await Promise.all(agents.flatMap(agent => {
            if (agent.execution?.kind !== 'flow') return [];
            const key = bindingKey(agent.execution);
            if (this.values.has(key)) return [];
            let pending = this.pending.get(key);
            if (!pending) {
                pending = this.inspect(agent.id, agent.execution, key, this.generation);
                this.pending.set(key, pending);
            }
            return [pending];
        }));
    }
    private async inspect(agentId: string, execution: Extract<AgentExecution, { kind: 'flow' }>, key: string, generation: number): Promise<void> {
        const started = Date.now(), operationId = ulid();
        let availability: AgentAvailability = { status: 'disabled', reason: 'flow-invalid', flowId: execution.flowId };
        try { if (this.source) availability = await this.source.inspect(execution); }
        catch (error) { this.logger.error('Agent Flow availability inspection failed', { operation: 'agent.flow.availability',
            operationId, stage: 'inspect', result: 'disabled', agentId, flowId: execution.flowId,
            category: error instanceof Error ? error.name : 'unknown', durationMs: Date.now() - started }); }
        if (generation !== this.generation) return;
        this.values.set(key, structuredClone(availability)); this.pending.delete(key);
        this.logger.info('Agent Flow availability observed', { operation: 'agent.flow.availability', operationId,
            stage: 'project', result: availability.status, category: availability.reason ?? 'ready',
            agentId, flowId: availability.flowId, durationMs: Date.now() - started });
    }
    project(agent: AgentDefinition): AgentDefinition {
        const { availability: _, ...source } = structuredClone(agent);
        if (source.execution?.kind !== 'flow') return source;
        return { ...source, availability: structuredClone(this.values.get(bindingKey(source.execution)) ?? {
            status: 'disabled', reason: 'flow-invalid', flowId: source.execution.flowId,
        }) };
    }
    dispose(): void { this.invalidate(); this.stop?.(); this.stop = undefined; this.source = undefined; }
}

export function agentSource(agent: AgentDefinition): AgentDefinition {
    const { availability: _, ...source } = structuredClone(agent);
    return source;
}

function bindingKey(execution: Extract<AgentExecution, { kind: 'flow' }>): string {
    return JSON.stringify([execution.flowId, execution.revision ?? null]);
}
