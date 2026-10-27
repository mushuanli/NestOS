import { vi } from 'vitest';
import type { EffectExecutionContext, EffectSessionState, JsonValue, SharedStateEntry } from '@itookit/durable-kernel';
import type { HarnessClient, HarnessEvent, HarnessHistory, HarnessMutationOptions, HarnessProfile, HarnessReceipt } from '@itookit/nestos-node-driver';
import type { HarnessExecutionRequest } from '@itookit/kernel-adapters/contracts';
import { createHarnessExecutionProvider } from '../src/projects/harness-execution';
import {settleExecutionContext} from '../src/projects/harness-execution-context';

export const request: HarnessExecutionRequest = {
    connection: { id: 'native', name: 'Native', kind: 'harness', nodeConnectionId: 'node', projectId: 'project', profileId: 'claude',
        version: 1, revision: 1, project: { serverProjectId: 'workspace' } },
    prompt: 'Private prompt', resourceHandleId: 'grant', notificationKey: 'native.notification',
};
export function durableState() {
    const records = new Map<string, SharedStateEntry>();
    const writes: string[] = [];
    const state: EffectSessionState = {
        get: async <T extends JsonValue>(key: string) => structuredClone(records.get(key)) as SharedStateEntry<T> | undefined,
        set: async <T extends JsonValue>(key: string, value: T, expectedVersion?: number | null) => {
            const prior = records.get(key);
            if (expectedVersion !== undefined && (prior?.version ?? null) !== expectedVersion) throw Object.assign(new Error('CAS conflict'), { code: 'CONFLICT' });
            const entry = { key, value: structuredClone(value), version: (prior?.version ?? 0) + 1, updatedAt: Date.now() };
            records.set(key, entry); writes.push(key); return structuredClone(entry);
        },
    };
    // This isolated state has no control holds; runtime tests exercise the Kernel admission transaction.
    state.setIfRunning = state.set;
    return { state, records, writes };
}
export function fixture() {
    const storage = durableState(), controller = new AbortController();
    const context: EffectExecutionContext = { sessionId: 'local-session', taskId: 'local-task', effectId: 'native-turn',
        attemptId: 'attempt-1', attemptNumber: 1, grants: [], abortSignal: controller.signal, sessionState: storage.state, emit: vi.fn(async () => {}) };
    const profile: HarnessProfile = { id: 'claude', kind: 'claude', projectRuntime: true, workspaces: [{ id: 'workspace' }],
        capabilities: { create: true, history: true, resume: true, interrupt: true, interactions: true } };
    const events: HarnessEvent[] = [], listeners = new Set<() => void>(), receipts = new Map<string, HarnessReceipt>();
    const session = { id: 'native-session', title: '', cwd: '/projects/workspace', status: 'active', updatedAt: 1, resumable: true, owned: true, activeTurnId: 'native-turn' };
    const data = { epoch: 'service-epoch', eventEpoch: 'event-epoch', gap: false, requests: [] as HarnessEvent['message'][],
        history: { session, turns: [] } as HarnessHistory };
    const committed = (options: HarnessMutationOptions | undefined, result: unknown) => {
        if (options?.requestId) receipts.set(options.requestId, { requestId: options.requestId, outcome: 'committed', result });
        return result;
    };
    const client = nativeClient(data, profile, events, listeners, receipts, committed);
    const release = vi.fn(async () => {}), connections = { validate: vi.fn(async () => {}), acquire: vi.fn(async () => ({ client, profile,
        workspaceId: 'workspace', epoch: data.epoch, release })) };
    const make = () => createHarnessExecutionProvider(connections, { pollMs: 5, cancelTimeoutMs: 100, stateForCleanup: async () => storage.state,
        settleContextForCleanup: (journal, unstarted) => settleExecutionContext(journal, unstarted) });
    const push = (method: string, params: Record<string, unknown>) => {
        events.push({ seq: events.length + 1, message: { method, params } }); for (const notify of listeners) notify();
    };
    return { ...storage, context, controller, data, session, client, profile, receipts, events, connections, release, make, push, committed };
}
function nativeClient(data: { epoch: string; eventEpoch: string; gap: boolean; history: HarnessHistory; requests: HarnessEvent['message'][] },
    profile: HarnessProfile, events: HarnessEvent[], listeners: Set<() => void>, receipts: Map<string, HarnessReceipt>,
    committed: (options: HarnessMutationOptions | undefined, result: unknown) => unknown): HarnessClient {
    return {
        profiles: vi.fn(async () => ({ epoch: data.epoch, profiles: [profile] })),
        list: vi.fn(async () => ({ sessions: [data.history.session], nextCursor: null })), read: vi.fn(async () => structuredClone(data.history)),
        create: vi.fn(async (_profile, _workspace, options) => committed(options, { session: data.history.session }) as { session: typeof data.history.session }),
        resume: vi.fn(async () => ({ session: data.history.session })),
        turn: vi.fn(async (_profile, _session, _prompt, options) => committed(options, { turnId: 'native-turn' }) as { turnId: string }),
        respond: vi.fn(async (_profile, _id, _response, options) => { committed(options, {}); }),
        interrupt: vi.fn(async (_profile, _session, _turn, options) => { committed(options, {}); }),
        subscribe: (_profile, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        eventSnapshot: vi.fn(async (_profile, cursor) => ({ epoch: data.eventEpoch, cursor: events.length, gap: data.gap,
            events: events.filter(event => !cursor || event.seq > cursor.after), requests: structuredClone(data.requests) })),
        operation: vi.fn(async (_profile, id) => receipts.get(id) ?? { requestId: id, outcome: 'not-committed', code: 'HARNESS_REQUEST_NOT_STARTED' }),
        close: vi.fn(async () => {}),
    };
}
export function complete(f: ReturnType<typeof fixture>, status = 'completed') {
    f.push('item/completed', { threadId: 'unrelated', turnId: 'native-turn', item: { id: 'wrong-session', type: 'agentMessage', text: 'ignore' } });
    f.push('item/completed', { threadId: 'native-session', turnId: 'older-turn', item: { id: 'old', type: 'agentMessage', text: 'ignore' } });
    f.push('item/completed', { threadId: 'native-session', turnId: 'native-turn', item: { id: 'first', type: 'agentMessage', text: 'First answer' } });
    f.push('item/completed', { threadId: 'native-session', turnId: 'native-turn', item: { id: 'first', type: 'agentMessage', text: 'First answer' } });
    f.push('item/completed', { threadId: 'native-session', turnId: 'native-turn', item: { id: 'second', type: 'agentMessage', content: [{ text: 'Second answer' }] } });
    f.push('turn/completed', { threadId: 'native-session', turn: { id: 'native-turn', status } });
}
export function interaction(f: ReturnType<typeof fixture>, kind: 'approval' | 'input' = 'approval') {
    f.data.requests = [{ id: 'question-1', method: kind === 'input' ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
        params: { threadId: 'native-session', turnId: 'native-turn', command: 'true', decisions: ['accept', 'decline', 'cancel'],
            questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }] }] } }];
}
