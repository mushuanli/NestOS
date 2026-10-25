import {attachmentMetadata} from '../contracts/chat';
import type { InstructionQueueEdit, SessionInstruction, SessionInstructionInput, SessionInstructionQueue } from '../contracts/instruction-queue';
import { ulid } from '../persistence/ulid';
import { sha256Hex } from '@itookit/llm-context';
import {assertTargetSelection, assertFlowCallSource} from '@itookit/llm-flow/contracts';

export function queueError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

export function prepareInstruction(input: SessionInstructionInput, sessionId: string, branch: string): SessionInstruction {
    if (input.expectedBranch !== undefined && (typeof input.expectedBranch !== 'string' || !input.expectedBranch.trim() || input.expectedBranch.length > 1024))
        throw queueError('QUEUE_INVALID', 'Invalid expected instruction branch');
    if (input.target) assertTargetSelection(input.target);
    if (input.target?.kind === 'flow' && input.agentId || input.target?.kind === 'agent' && input.target.id !== input.agentId)
        throw queueError('CALL_TARGET_CONFLICT', 'Call target conflicts with the legacy Agent selection');
    if (!Array.isArray(input.files) || typeof input.agentId !== 'string') throw queueError('QUEUE_INVALID', 'Invalid instruction input');
    if (typeof input.text !== 'string' || (!input.text.trim() && !input.files.length && !flowInput(input)))
        throw queueError('QUEUE_INVALID', 'Instruction text, attachments or a Flow call are required');
    const id = input.sendIntent?.submission?.id ?? ulid();
    if (!/^[\w-]{1,128}$/.test(id)) throw queueError('QUEUE_INVALID', 'Invalid instruction identity');
    const files = input.files.map(attachmentMetadata);
    const intent = input.sendIntent ?? { execution: { kind: 'agent', agentId: input.agentId }, branch: { mode: 'continue' }, retention: { mode: 'persistent' } };
    const value = { text: input.text, agentId: input.agentId, overrides: input.overrides, origin: input.origin,
        ...(input.expectedBranch !== undefined ? {expectedBranch: input.expectedBranch} : {}),
        ...(input.target ? {target: input.target} : {}), ...(input.expectedTarget ? {expectedTarget: input.expectedTarget} : {}), ...(input.source ? {source: input.source} : {}),
        historyPolicy: input.historyPolicy, files, sendIntent: { ...intent, submission: intent.submission ?? {
        id, source: { kind: 'conversation', ownerId: sessionId, id },
    } }, id, branch, createdAt: Date.now(), state: 'pending' };
    assertInstructionSize(value);
    return JSON.parse(JSON.stringify(value)) as SessionInstruction;
}

function flowInput(input: SessionInstructionInput): boolean {
    return input.target?.kind === 'flow' || input.source?.kind === 'arguments' || input.sendIntent?.execution.kind === 'flow' || input.overrides?.flowParameters !== undefined;
}

export function assertPreparedInstruction(item: SessionInstruction): void {
    if (!item.text.trim() && !item.files.length && !item.flowBinding)
        throw queueError('QUEUE_INVALID', 'Empty instructions require a validated Flow binding');
}

export function assertInstructionSize(value: unknown): void {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw queueError('QUEUE_LIMIT', 'Instruction exceeds 1 MiB');
}

export function editInstructionQueue(queue: SessionInstructionQueue, edit: InstructionQueueEdit): SessionInstructionQueue {
    assertRevision(queue, edit);
    const next = structuredClone(queue);
    switch (edit.action) {
        case 'update': return updateText(next, edit.id, edit.text);
        case 'update-input': return updateInput(next, edit.id, edit.source);
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
    if (selected.some(item => item.source?.kind === 'arguments'))
        throw queueError('QUEUE_INCOMPATIBLE', 'Structured calls must be edited explicitly; no argument merge policy is declared');
    const [target] = selected;
    if (selected.some(item => signature(item) !== signature(target))) {
        throw queueError('QUEUE_INCOMPATIBLE', 'Merged instructions must use the same branch, agent and execution settings');
    }
    const indices = selected.map(item => queue.items.indexOf(item));
    if (indices.some((index, offset) => index !== indices[0] + offset)) throw queueError('QUEUE_INVALID', 'Only adjacent instructions can be merged');
    target.text = selected.map(item => item.text).join('\n\n');
    if (target.source?.kind === 'composer') target.source.text = target.text;
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
    if (item.expectedBranch !== undefined) values.push(['expectedBranch', item.expectedBranch]);
    if (item.target) values.push(['target', item.target]);
    if (item.expectedTarget) values.push(['expectedTarget', item.expectedTarget]);
    if (item.source) values.push(['source', includeBinding && item.source.kind === 'composer' ? {...item.source, text: ''} : item.source]);
    if (includeBinding && item.connectionBinding) values.push(item.connectionBinding);
    if (includeBinding && item.flowBinding) values.push(item.flowBinding);
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

function updateText(queue: SessionInstructionQueue, id: string, text: string): SessionInstructionQueue {
    const [item] = editable(queue, [id]);
    if (item.source?.kind === 'arguments') throw queueError('QUEUE_INPUT_EDITOR_REQUIRED', 'Edit the structured arguments for this instruction');
    if (typeof text !== 'string' || (!text.trim() && !item.files.length && !item.flowBinding)) throw queueError('QUEUE_INVALID', 'Instruction text, attachments or a validated Flow call are required');
    item.text = text;
    if (item.source?.kind === 'composer') item.source.text = text;
    assertInstructionSize(item);
    if (new TextEncoder().encode(JSON.stringify(queue)).byteLength > 4 * 1024 * 1024) throw queueError('QUEUE_LIMIT', 'Instruction queue exceeds 4 MiB');
    return queue;
}

function updateInput(queue: SessionInstructionQueue, id: string, source: SessionInstructionInput['source']): SessionInstructionQueue {
    const [item] = editable(queue, [id]);
    assertFlowCallSource(source);
    if (!item.flowBinding && source.kind !== 'composer') throw queueError('QUEUE_INVALID', 'Structured arguments require a Flow binding');
    if (source.kind === 'composer' && canonical(source.attachments) !== canonical(item.source?.kind === 'composer' ? item.source.attachments : []))
        throw queueError('QUEUE_ATTACHMENT_EDIT_UNSUPPORTED', 'Prepare attachments before editing the instruction input');
    item.source = structuredClone(source); item.text = source.kind === 'composer' ? source.text : '';
    if (item.flowBinding && item.overrides) delete item.overrides.flowParameters;
    assertInstructionSize(item);
    return queue;
}
