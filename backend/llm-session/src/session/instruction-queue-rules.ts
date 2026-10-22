import type { InstructionQueueEdit, SessionInstruction, SessionInstructionInput, SessionInstructionQueue } from '../contracts/instruction-queue';
import { ulid } from '../persistence/ulid';
import { sha256Hex } from '@itookit/llm-context';

export function queueError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

export function prepareInstruction(input: SessionInstructionInput, sessionId: string, branch: string): SessionInstruction {
    if (!Array.isArray(input.files) || typeof input.agentId !== 'string') throw queueError('QUEUE_INVALID', 'Invalid instruction input');
    if (typeof input.text !== 'string' || (!input.text.trim() && !input.files.length)) throw queueError('QUEUE_INVALID', 'Instruction text or attachments are required');
    const id = input.sendIntent?.submission?.id ?? ulid();
    if (!/^[\w-]{1,128}$/.test(id)) throw queueError('QUEUE_INVALID', 'Invalid instruction identity');
    const files = input.files.map(file => ({ name: file.name, type: file.type, path: file.path, size: file.size }));
    const intent = input.sendIntent ?? { execution: { kind: 'agent', agentId: input.agentId }, branch: { mode: 'continue' }, retention: { mode: 'persistent' } };
    const value = { ...input, files, sendIntent: { ...intent, submission: intent.submission ?? {
        id, source: { kind: 'conversation', ownerId: sessionId, id },
    } }, id, branch, createdAt: Date.now(), state: 'pending' };
    assertInstructionSize(value);
    return JSON.parse(JSON.stringify(value)) as SessionInstruction;
}

export function assertInstructionSize(value: unknown): void {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw queueError('QUEUE_LIMIT', 'Instruction exceeds 1 MiB');
}

export function editInstructionQueue(queue: SessionInstructionQueue, edit: InstructionQueueEdit): SessionInstructionQueue {
    assertRevision(queue, edit);
    const next = structuredClone(queue);
    switch (edit.action) {
        case 'remove': editable(next, [edit.id], true); next.items = next.items.filter(item => item.id !== edit.id); break;
        case 'reorder': return reorder(next, edit.ids);
        case 'merge': return merge(next, edit.ids);
        case 'pause': next.paused = true; next.reason = undefined; break;
        case 'resume': return resume(next);
        case 'retry': return retry(next, edit.id);
        default: throw queueError('QUEUE_INVALID', 'Unknown instruction queue operation');
    }
    return next;
}

function assertRevision(queue: SessionInstructionQueue, edit: InstructionQueueEdit): void {
    if (!edit || !Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision !== queue.revision) {
        throw queueError('QUEUE_CONFLICT', 'Instruction queue changed; refresh before editing');
    }
}

function resume(queue: SessionInstructionQueue): SessionInstructionQueue {
    if (queue.items.some(item => item.state === 'uncertain' || item.state === 'failed')) throw queueError('QUEUE_BLOCKED', 'Resolve failed or uncertain instructions before resuming');
    queue.paused = false; queue.reason = undefined;
    return queue;
}

function retry(queue: SessionInstructionQueue, id: string): SessionInstructionQueue {
    const [item] = editable(queue, [id], true);
    if (item.state !== 'failed') throw queueError('QUEUE_INVALID', 'Only an instruction rejected before execution may be retried');
    item.state = 'pending'; item.error = undefined; queue.paused = false; queue.reason = undefined;
    return queue;
}

function editable(queue: SessionInstructionQueue, ids: string[], allowFailure = false): SessionInstruction[] {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw queueError('QUEUE_INVALID', 'Select distinct queued instructions');
    return ids.map(id => {
        const item = queue.items.find(entry => entry.id === id);
        if (!item || item.state === 'dispatching' || (!allowFailure && item.state !== 'pending')) {
            throw queueError('QUEUE_CONFLICT', 'Only pending instructions can be changed');
        }
        return item;
    });
}

function reorder(queue: SessionInstructionQueue, ids: string[]): SessionInstructionQueue {
    const pending = queue.items.filter(item => item.state === 'pending');
    if (!Array.isArray(ids) || ids.length !== pending.length) throw queueError('QUEUE_INVALID', 'Reordering must include every pending instruction exactly once');
    const ordered = editable(queue, ids);
    let index = 0;
    queue.items = queue.items.map(item => item.state === 'pending' ? ordered[index++] : item);
    return queue;
}

function merge(queue: SessionInstructionQueue, ids: string[]): SessionInstructionQueue {
    if (!Array.isArray(ids) || ids.length < 2) throw queueError('QUEUE_INVALID', 'Select at least two instructions to merge');
    editable(queue, ids);
    const selected = queue.items.filter(item => ids.includes(item.id));
    const [target] = selected;
    if (selected.some(item => signature(item) !== signature(target))) {
        throw queueError('QUEUE_INCOMPATIBLE', 'Merged instructions must use the same branch, agent and execution settings');
    }
    const indices = selected.map(item => queue.items.indexOf(item));
    if (indices.some((index, offset) => index !== indices[0] + offset)) throw queueError('QUEUE_INVALID', 'Only adjacent instructions can be merged');
    target.text = selected.map(item => item.text).join('\n\n');
    target.files = selected.flatMap(item => item.files).filter((file, index, files) =>
        files.findIndex(other => JSON.stringify(other) === JSON.stringify(file)) === index);
    assertInstructionSize(target);
    queue.items = queue.items.filter(item => item === target || !ids.includes(item.id));
    return queue;
}

function signature(item: SessionInstruction, includeBinding = true): string {
    const { submission: _submission, ...intent } = item.sendIntent ?? {};
    const source = item.sendIntent?.submission?.source;
    const owner = source?.kind === 'project-draft' ? source : source ? { kind: source.kind, ownerId: source.ownerId } : null;
    const values = [item.branch, item.agentId, item.overrides ?? null, item.origin ?? 'user', item.historyPolicy ?? 'include', intent, owner];
    if (includeBinding && item.connectionBinding) values.push(item.connectionBinding);
    return canonical(values);
}

export function instructionDigest(item: SessionInstruction): Promise<string> {
    return sha256Hex(canonical([item.text, item.files, signature({ ...item, branch: '' }, false)]));
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
    return JSON.stringify(value);
}
