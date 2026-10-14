import type { ChatMessage } from '../domain/message';
import type {
    ContextPrepareInput, ContextRequestSnapshot, ContextServicePorts, IContextService,
    PreparedContext, WorkingNotes,
} from '../domain/durable';
import { sha256Hex } from '../content/digest';
import { contextKey } from '../content/store';
import { serializeContext } from '../content/serialize';
import { ContextError, createContextEngine, measureContext, requirePositive } from '../window/engine';
import { createContextReader, loadRequest } from './reader';

export function createContextService(ports: ContextServicePorts): IContextService {
    ports = { ...ports, engine: ports.engine ?? createContextEngine(ports.engineOptions) };
    const reader = createContextReader(ports);
    return { ...reader, request: cursor => loadRequest(ports, cursor),
        prepare: input => prepare(ports, input),
        admitOutput: (output, maxBytes = 16_384) => admitOutput(ports, output, maxBytes) };
}

async function prepare(ports: ContextServicePorts, input: ContextPrepareInput): Promise<PreparedContext> {
    const fingerprint = await sha256Hex(serializeContext(input));
    const receiptKey = contextKey(input.contextId, `receipt/${encodeURIComponent(input.operationId)}`);
    const receipt = await ports.records.get(receiptKey) as { fingerprint: string; prepared: PreparedContext } | undefined;
    if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ContextError('CONTEXT_CONFLICT', 'Context operation identity was reused');
        return { ...receipt.prepared, writes: [] };
    }
    if (input.previous && input.previous.contextId !== input.contextId) throw new ContextError('CONTEXT_CONFLICT', 'Context identity mismatch');
    const previous = input.previous ? await loadRequest(ports, input.previous) : null;
    const history = await ports.content.publish(JSON.stringify({ id: input.operationId,
        previous: previous?.history ?? null, messages: input.messages }));
    const snapshot = await buildSnapshot(ports, input, previous, history);
    const ref = await ports.content.publish(JSON.stringify(snapshot));
    const cursor = { contextId: input.contextId, revision: snapshot.revision, generation: snapshot.generation, snapshot: ref };
    const prepared: PreparedContext = { cursor, explanation: snapshot.explanation, writes: [] };
    prepared.writes = [
        { key: contextKey(input.contextId, 'head'), value: cursor, expectedVersion: input.previous?.revision ?? null },
        { key: receiptKey, value: { fingerprint, prepared: { ...prepared, writes: [] } }, expectedVersion: null },
    ];
    return prepared;
}

async function buildSnapshot(ports: ContextServicePorts, input: ContextPrepareInput,
    previous: ContextRequestSnapshot | null, history: ContextRequestSnapshot['history']): Promise<ContextRequestSnapshot> {
    if (input.archiveOnly && previous) return { ...previous, history, revision: previous.revision + 1 };
    const engine = ports.engine ?? createContextEngine();
    const messages = mergeMessages(previous?.request.messages ?? [], input.messages);
    if (!previous) pinObjective(messages);
    const selection = engine.select(messages, input.request, input.notes
        ? { ...input.policy, maxMessages: 1, keepRecent: 1, strategy: 'checkpoint-reset' } : input.policy);
    const notes = await resolveNotes(ports, input, previous, selection.removed, history);
    if (notes) applyNotes(engine, input, selection, notes);
    const request = { ...input.request, messages: selection.messages };
    const budget = measureContext(engine, request, input.policy);
    if (budget.inputTokens > budget.maxInputTokens)
        throw new ContextError('CONTEXT_REQUIRED_INPUT_TOO_LARGE', 'Selected context exceeds the input budget');
    selection.explanation.inputTokens = budget.inputTokens;
    selection.explanation.estimated = budget.estimated;
    return { schema: 1, contextId: input.contextId, revision: (previous?.revision ?? 0) + 1,
        generation: (previous?.generation ?? 0) + Number(Boolean(input.notes) || selection.removed.length > 0), history, notes,
        request, digest: await sha256Hex(JSON.stringify(request)), explanation: selection.explanation };
}

function applyNotes(engine: import('../domain/durable').IContextEngine, input: ContextPrepareInput,
    selection: import('../domain/durable').WindowSelection, notes: WorkingNotes): void {
    selection.messages = insertNotes(selection.messages, notes);
    const budget = measureContext(engine, { ...input.request, messages: selection.messages }, input.policy);
    if (budget.inputTokens > budget.maxInputTokens)
        throw new ContextError('CONTEXT_COMPACTION_NO_PROGRESS', 'Checkpoint notes exceed the remaining context budget');
    if (input.notes || selection.removed.length)
        selection.explanation.strategy = input.notes || input.policy?.strategy === 'checkpoint-reset' ? 'checkpoint-reset' : 'summary-tail';
}

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    // Runtime skill policies are refreshed as a set; ordinary host policies remain pinned.
    const base = previous.filter(message => !message.tags?.includes('context-notes')
        && !message.tags?.includes('context-skill-policy'));
    const keys = new Set(base.filter(message => ['system', 'developer'].includes(message.role)).map(message => JSON.stringify(message)));
    return [...base, ...incoming.filter(message => !['system', 'developer'].includes(message.role) || !keys.has(JSON.stringify(message)))];
}

function pinObjective(messages: ChatMessage[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role !== 'user') continue;
        messages[index] = { ...messages[index], tags: [...(messages[index].tags ?? []), 'context-objective'] };
        return;
    }
}

async function resolveNotes(ports: ContextServicePorts, input: ContextPrepareInput,
    previous: ContextRequestSnapshot | null, removed: ChatMessage[], history: ContextRequestSnapshot['history']): Promise<WorkingNotes | null> {
    if (input.notes || (removed.length && input.policy?.strategy === 'checkpoint-reset')) {
        const notes = input.notes;
        if (!notes || notes.basedOnRevision !== (previous?.revision ?? 0)
            || notes.revision !== (previous?.notes?.revision ?? 0) + 1 || !notes.text.trim() || !notes.evidence.length) {
            throw new ContextError('CONTEXT_CHECKPOINT_REQUIRED', 'Reset requires current notes with evidence');
        }
        for (const ref of notes.evidence) await ports.content.read(ref);
        return notes;
    }
    if (!removed.length) return previous?.notes ?? null;
    if (input.policy?.strategy !== 'summary-tail') return previous?.notes ?? null;
    if (!ports.summarize) throw new ContextError('CONTEXT_SUMMARIZER_UNAVAILABLE', 'No context summarizer is configured');
    const tokens = input.policy.summaryTokens ?? 1024;
    requirePositive(tokens);
    const sources: ChatMessage[] = previous?.notes ? [{ role: 'user', content: previous.notes.text }, ...removed] : removed;
    const budget = measureContext(ports.engine!, { ...input.request, messages: sources }, input.policy);
    if (budget.inputTokens > budget.maxInputTokens) {
        throw new ContextError('CONTEXT_REQUIRED_INPUT_TOO_LARGE', 'Summary source exceeds the input budget; checkpoint notes are required');
    }
    const text = await ports.summarize(sources, tokens);
    if (!text.trim() || new TextEncoder().encode(text).length > tokens * 4) {
        throw new ContextError('CONTEXT_COMPACTION_NO_PROGRESS', 'Summary is empty or exceeds its output budget');
    }
    return { revision: (previous?.notes?.revision ?? 0) + 1, basedOnRevision: previous?.revision ?? 0, text, evidence: [history] };
}

function insertNotes(messages: ChatMessage[], notes: WorkingNotes): ChatMessage[] {
    const index = messages.findIndex(message => !['system', 'developer'].includes(message.role));
    const result = [...messages];
    result.splice(index < 0 ? messages.length : index, 0, { role: 'user', tags: ['context-notes'],
        content: `Working notes (derived observations; verify against history):\n${notes.text}` });
    return result;
}

async function admitOutput(ports: ContextServicePorts, output: string, maxBytes: number) {
    requirePositive(maxBytes);
    const bytes = new TextEncoder().encode(output);
    if (bytes.length <= maxBytes) return { output };
    const contentRef = await ports.content.publish(output, 'text/plain');
    const header = `\n[Output truncated; use context_read with ref=${JSON.stringify(contentRef)}]\n`;
    const remaining = maxBytes - new TextEncoder().encode(header).length - 8;
    if (remaining < 0) throw new ContextError('CONTEXT_INVALID_LIMIT', 'Output budget cannot fit a content reference');
    const length = Math.floor(remaining / 2);
    const decoder = new TextDecoder();
    return { contentRef, output: `${decoder.decode(bytes.slice(0, length))}${header}${decoder.decode(bytes.slice(bytes.length - length))}` };
}
