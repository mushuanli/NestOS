import { readFlowRunMembers } from './run-members';
import type { Kernel, TaskRecord } from '@itookit/durable-kernel';

export interface FlowTranscriptQuery {
    version?: number;
    offset?: number;
    limit?: number;
    /** Upper bound for the JSON-encoded transcript; oversized pages are trimmed deterministically. */
    maxBytes?: number;
}

export interface FlowTaskTranscript {
    totalEffects: number;
    nextOffset?: number;
    sessionId: string;
    runTaskId: string;
    taskId: string;
    nodeId?: string;
    status: TaskRecord['status'];
    version: number;
    input: unknown;
    output: unknown;
    effects: Array<{ effectId: string } & TaskRecord['effects'][string]>;
    interactions: TaskRecord['interactions'];
    /** JSON size of this page in UTF-8 bytes. */
    bytes: number;
    /** True when `maxBytes` forced payloads or effects to be dropped. */
    truncated?: boolean;
}

const TRUNCATED = '[truncated]';

function byteLength(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value) ?? 'null').length;
}

/** Replace over-long strings inside a payload, deepest-first, until the value fits. */
function shrinkValue(value: unknown, budget: number): unknown {
    if (byteLength(value) <= budget) return value;
    if (typeof value === 'string') return value.length > 32 ? value.slice(0, 32) + '…' : value;
    if (Array.isArray(value)) return value.map(item => shrinkValue(item, Math.max(1, Math.floor(budget / value.length))));
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        const share = Math.max(1, Math.floor(budget / Math.max(1, entries.length)));
        return Object.fromEntries(entries.map(([key, item]) => [key, shrinkValue(item, share)]));
    }
    return value;
}

/**
 * Fit a transcript page into `maxBytes` without changing what it claims to hold.
 *
 * Order: drop trailing effects (the page already supports `nextOffset`), then
 * shrink the input/output payloads, then keep only the first effect, and finally
 * fall back to the header alone. The header (ids, status, version, totals) is
 * always preserved so a caller can still page or retry.
 */
export function fitTranscriptBudget(transcript: FlowTaskTranscript, maxBytes: number, offset = 0): FlowTaskTranscript {
    const measure = (candidate: FlowTaskTranscript) => byteLength({ ...candidate, bytes: 0 });
    if (measure(transcript) <= maxBytes) return withSize(transcript);

    let effects = [...transcript.effects];
    const nextOffsetFor = (kept: number) => (offset + kept < transcript.totalEffects ? offset + kept : undefined);
    while (effects.length > 1 && measure({ ...transcript, effects }) > maxBytes) effects = effects.slice(0, -1);
    let page: FlowTaskTranscript = {
        ...transcript, effects,
        ...(effects.length === transcript.effects.length ? {} : { nextOffset: nextOffsetFor(effects.length) }),
    };
    if (measure(page) > maxBytes) {
        page = { ...page, input: shrinkValue(page.input, Math.max(1, Math.floor(maxBytes / 4))),
            output: shrinkValue(page.output, Math.max(1, Math.floor(maxBytes / 4))) };
    }
    if (measure(page) > maxBytes && page.effects.length) {
        const share = Math.max(1, Math.floor(maxBytes / page.effects.length));
        page = { ...page, effects: page.effects.map(effect => shrinkValue(effect, share) as typeof effect) };
    }
    if (measure(page) > maxBytes && page.effects.length > 1) {
        page = { ...page, effects: page.effects.slice(0, 1), nextOffset: nextOffsetFor(1) };
    }
    if (measure(page) > maxBytes) {
        page = { ...page, input: TRUNCATED, output: TRUNCATED, effects: [], nextOffset: nextOffsetFor(0) };
    }
    return withSize(page, true);
}

function withSize(transcript: FlowTaskTranscript, truncated = false): FlowTaskTranscript {
    let bytes = byteLength({ ...transcript, bytes: 0 });
    bytes = byteLength({ ...transcript, bytes });
    return truncated ? { ...transcript, bytes, truncated: true } : { ...transcript, bytes };
}

/** Read recorded exchanges, including those removed from the Agent's compacted message window. */
export async function readFlowTaskTranscript(
    kernel: Kernel, sessionId: string, runTaskId: string, taskId: string, query: FlowTranscriptQuery = {},
): Promise<FlowTaskTranscript> {
    const offset = query.offset ?? 0, limit = query.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
        || (offset > 0 && query.version === undefined)
        || (query.version !== undefined && (!Number.isSafeInteger(query.version) || query.version < 0))
        || (query.maxBytes !== undefined && (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 64))) {
        throw new Error('Invalid transcript page');
    }
    const session = await kernel.inspectSession(sessionId);
    const root = (await (await session.attachTask(runTaskId)).status()).task;
    const entries = await readFlowRunMembers(session, root);
    if (taskId !== runTaskId && !entries.some(item => item.taskId === taskId)) {
        throw new Error(`Task is outside this run: ${taskId}`);
    }
    const task = query.version === undefined
        ? taskId === runTaskId ? root : (await (await session.attachTask(taskId)).status()).task
        : (await kernel.taskHistoryPage(sessionId, taskId, {
            afterVersion: query.version - 1, throughVersion: query.version, limit: 1,
        })).items[0];
    if (!task || (query.version !== undefined && task.version !== query.version)) throw new Error('Transcript version unavailable');
    const effects = Object.entries(task.effects).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (offset > effects.length) throw new Error('Invalid transcript offset');
    const page: FlowTaskTranscript = {
        totalEffects: effects.length,
        ...(offset + limit < effects.length ? { nextOffset: offset + limit } : {}),
        sessionId, runTaskId, taskId, nodeId: task.labels?.flowNodeId,
        status: task.status, version: task.version, input: task.input, output: task.output,
        effects: effects.slice(offset, offset + limit).map(([effectId, effect]) => ({ effectId, ...effect })),
        interactions: task.interactions,
        bytes: 0,
    };
    return query.maxBytes === undefined ? withSize(page) : fitTranscriptBudget(page, query.maxBytes, offset);
}
