import type { JsonValue, Kernel } from '@itookit/durable-kernel';
import type { SessionInstructionQueue } from '../contracts/instruction-queue';

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
        ids.add(item.id);
    }
    if (value.accepted !== undefined && (!Array.isArray(value.accepted) || value.accepted.some(receipt =>
        typeof receipt.id !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)))) invalid();
}
