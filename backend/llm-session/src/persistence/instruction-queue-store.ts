import type { JsonValue, Kernel } from '@itookit/durable-kernel';
import type { SessionInstructionQueue } from '../contracts/instruction-queue';
import { flowRevisionDigest } from '@itookit/llm-flow';
import { isFlowConnectionSnapshot } from '../session/flow-connection-snapshot';
import { isHarnessAgentSnapshot } from '../session/harness-binding';
import { isFlowRunPlan } from '../session/flow-run-plan';
import { isModelDefaults } from '@itookit/kernel-adapters/contracts';

export const INSTRUCTION_QUEUE_KEY = 'conversation/instructions';
export interface StoredInstructionQueue extends SessionInstructionQueue {
    accepted?: Array<{ id: string; digest: string }>;
}

export function instructionQueueProjection(queue: SessionInstructionQueue): SessionInstructionQueue {
    return structuredClone({ sessionId: queue.sessionId, revision: queue.revision, paused: queue.paused, reason: queue.reason, items: queue.items });
}

export async function readSessionInstructionQueue(kernel: Kernel, sessionId: string): Promise<SessionInstructionQueue> {
    return instructionQueueProjection(await new InstructionQueueStore(kernel).read(sessionId));
}

/** The Kernel supplies versioned storage; queue semantics stay in llm-session. */
export class InstructionQueueStore {
    constructor(private readonly kernel: Kernel) {}

    async read(sessionId: string): Promise<StoredInstructionQueue> {
        const session = await this.kernel.inspectSession(sessionId);
        const entry = await session.getShared(INSTRUCTION_QUEUE_KEY);
        if (!entry) return { sessionId, revision: 0, paused: false, items: [] };
        const value = entry.value as unknown as StoredInstructionQueue & { schemaVersion?: number };
        validateQueue(value, sessionId);
        return { ...structuredClone(value), revision: entry.version };
    }

    async write(queue: StoredInstructionQueue): Promise<StoredInstructionQueue> {
        const handle = await this.kernel.openSession(queue.sessionId);
        const value = JSON.parse(JSON.stringify({ ...queue, schemaVersion: 1 })) as JsonValue;
        const entry = await handle.setShared(INSTRUCTION_QUEUE_KEY, value,
            { expectedVersion: queue.revision || null });
        return { ...queue, revision: entry.version };
    }
}

function validateQueue(value: StoredInstructionQueue & {schemaVersion?: number}, sessionId: string): void {
    const invalid = () => { throw Object.assign(new Error('Invalid instruction queue storage'), { code: 'QUEUE_STORAGE_INVALID' }); };
    if (!value || value.schemaVersion !== 1 || value.sessionId !== sessionId || typeof value.paused !== 'boolean' || !Array.isArray(value.items)) invalid();
    const ids = new Set<string>();
    for (const item of value.items) {
        if (!item || typeof item.id !== 'string' || !/^[\w-]{1,128}$/.test(item.id) || ids.has(item.id)
            || !['pending', 'dispatching', 'failed', 'uncertain'].includes(item.state) || typeof item.text !== 'string'
            || typeof item.branch !== 'string' || typeof item.agentId !== 'string' || !Number.isFinite(item.createdAt)
            || item.submissionDigest !== undefined && !/^[a-f0-9]{64}$/.test(item.submissionDigest)
            || !Array.isArray(item.files) || item.files.some(file => !file || typeof file.name !== 'string' || typeof file.type !== 'string')) invalid();
        if (item.flowBinding !== undefined && !validFlowBinding(item)) invalid();
        if (item.connectionBinding !== undefined && (!item.connectionBinding || !isModelDefaults(item.connectionBinding.defaults)
            || item.connectionBinding.harnessAgent !== undefined && (!isHarnessAgentSnapshot(item.connectionBinding.harnessAgent)
                || item.connectionBinding.harnessAgent.id !== item.agentId)
            || item.connectionBinding.connectionId !== undefined && typeof item.connectionBinding.connectionId !== 'string'
            || item.connectionBinding.connections !== undefined && !isFlowConnectionSnapshot(item.connectionBinding.connections))) invalid();
        ids.add(item.id);
    }
    if (value.accepted !== undefined && (!Array.isArray(value.accepted) || value.accepted.some(receipt =>
        typeof receipt.id !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)))) invalid();
}

function validFlowBinding(item: SessionInstructionQueue['items'][number]): boolean {
    try {
        const binding = item.flowBinding, execution = item.sendIntent?.execution;
        if (!binding || !binding.definition || !Array.isArray(binding.dependencies) || !binding.agent
            || binding.agent.id !== item.agentId || typeof binding.agent.agentVersion !== 'string'
            || execution?.kind !== 'flow' || binding.source !== undefined && binding.source !== 'explicit') return false;
        if (!isFlowConnectionSnapshot(binding.connections)) return false;
        if (binding.plan !== undefined && !isFlowRunPlan(binding.plan)) return false;
        const flow = binding.definition, agent = binding.agent.execution;
        if (execution.flowId !== flow.id || execution.revision !== flow.revision) return false;
        if (binding.source !== 'explicit' && (agent?.kind !== 'flow' || agent.flowId !== flow.id
            || agent.revision !== undefined && agent.revision !== flow.revision)) return false;
        return [flow, ...binding.dependencies].every(definition => !!definition && typeof definition.id === 'string'
            && Number.isSafeInteger(definition.revision) && definition.revision > 0 && Array.isArray(definition.nodes)
            && Array.isArray(definition.edges) && definition.digest === flowRevisionDigest(definition));
    } catch { return false; }
}
