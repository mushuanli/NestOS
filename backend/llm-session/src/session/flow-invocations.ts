import type { JsonValue, DagRunSpec } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '../contracts';
import type { Kernel, TaskRecord, SessionHandle } from '@itookit/durable-kernel';
import { FlowCommand, FlowDefinitionStore, validateFlowParameters } from '@itookit/llm-flow';
import type { FlowInvocationSessions } from '../persistence/flow-invocation-sessions';

import { FlowInvocationCommand, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
export { FlowInvocationCommand, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
const PREFIX = 'flow.invocation.';
/** Shared records already read by a caller, so recovery does not list them twice. */
type StoredInvocations = Awaited<ReturnType<Kernel['listShared']>>;

/** Calls live beside chat history; their completion never moves the conversation head. */
export class FlowInvocationService {
    private pending = new Map<string, Promise<FlowInvocationRecord>>();
    constructor(private kernel: Kernel, private definitions: FlowDefinitionStore, private commands: ICommandBus,
        private canWrite?: (id: string) => Promise<boolean>,
        private source?: (id: string) => Promise<{ branch: string; head: string | null }>,
        private resolveConnection?: (sessionId: string, connectionId?: string) => Promise<string | undefined>,
        private invocationSessions?: FlowInvocationSessions) {}

    register(): void {
        this.commands.register(FlowInvocationCommand.Invoke, args => this.invoke(args as FlowInvocationInput));
        this.commands.register(FlowInvocationCommand.List, args => this.list((args as { sessionId: string }).sessionId));
    }

    async invoke(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        if (!/^[\w-]{1,128}$/.test(input.requestId)) throw new Error('Invalid Flow invocation request id');
        const key = `${input.sessionId}/${input.requestId}`;
        const previous = this.pending.get(key);
        if (previous) { const record = await previous; this.assertSame(record, input); return record; }
        const operation = this.submit(structuredClone(input));
        this.pending.set(key, operation);
        try { return await operation; } finally { this.pending.delete(key); }
    }

    async list(sessionId: string, stored?: StoredInvocations): Promise<FlowInvocationRecord[]> {
        const entries = stored ?? await this.kernel.listShared(sessionId, PREFIX);
        if (entries.length === 0) return [];
        const session = await this.kernel.inspectSession(sessionId);
        const tasks = await session.listTasks();
        return entries.map(entry => {
            const record = entry.value as unknown as FlowInvocationRecord;
            const root = this.findRoot(tasks, record.requestId);
            return { ...record, ...(root ? { rootTaskId: root.id, error: undefined } : {}) };
        }).sort((a, b) => a.createdAt - b.createdAt);
    }

    async recover(): Promise<void> {
        // The persisted marker lists the Sessions that ever admitted a call; without it every
        // Session is probed once and the probe result is then sealed (see below).
        const marker = this.invocationSessions;
        const marked = marker ? await marker.sessions().catch(() => undefined) : undefined;
        const found = new Set<string>();
        let complete = true;
        for await (const session of this.kernel.listSessions()) {
            // The catalog record already carries the Session status; listing the persisted
            // records validates the storage, so no extra sessionStat round trip is needed.
            if (session.status !== 'open') continue;
            if (marked && !marked.has(session.id)) continue;
            let stored: StoredInvocations;
            try { stored = await this.kernel.listShared(session.id, PREFIX); }
            catch (error) {
                // An interrupted removal leaves a catalog entry without storage.
                complete = false;
                console.warn(`[Flow] Invocation recovery skipped for Session ${session.id}`, error);
                continue;
            }
            if (stored.length === 0) continue;
            found.add(session.id);
            if (this.canWrite && !await this.canWrite(session.id)) continue;
            for (const record of await this.list(session.id, stored)) {
                try {
                    if (!record.rootTaskId && !record.error) await this.invoke(record);
                    else if (record.rootTaskId) await this.commands.execute(FlowCommand.RunResume, { sessionId: session.id, taskId: record.rootTaskId });
                } catch (error) { console.error('Flow invocation recovery failed', session.id, record.requestId, error); }
            }
        }
        // Seal a probe that covered every Session, so later boots take the cheap path even when
        // no Session holds a call. An incomplete pass stays unknown and is probed again.
        if (marker && marked === undefined && complete) await marker.establish(found);
    }

    private async submit(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        await this.assertWritable(input.sessionId);
        // Mark the Session before its first invocation record is written, so a later boot knows
        // which Sessions to scan. A mark failure surfaces here instead of hiding a lost resume.
        await this.invocationSessions?.mark(input.sessionId);
        const session = await this.kernel.openSession(input.sessionId), key = PREFIX + input.requestId;
        let record = await this.admit(input, session);
        const existing = this.findRoot(await session.listTasks(), input.requestId);
        if (existing) return { ...record, rootTaskId: existing.id, error: undefined };
        const invocation: DagRunSpec['invocation'] = { requestId: input.requestId, flowId: input.flowId,
            revision: record.flow.revision, digest: record.flow.digest, name: record.flow.name, createdAt: record.createdAt,
            ...(record.branch ? { branch: record.branch, head: record.head } : {}) };
        try {
            await this.assertWritable(input.sessionId);
            const { taskId } = await this.commands.execute<{ taskId: string }>(FlowCommand.RunStart, {
                sessionId: input.sessionId, flow: record.flow, parameters: record.parameters, invocation,
                connectionId: record.connectionId, fallbackConnectionId: record.resolvedConnectionId,
            });
            record = { ...record, rootTaskId: taskId, error: undefined };
        } catch (error) {
            const root = this.findRoot(await session.listTasks(), input.requestId);
            if (root) return { ...record, rootTaskId: root.id, error: undefined };
            await session.setShared(key, json({ ...record, error: String(error) }));
            throw error;
        }
        await session.setShared(key, json(record));
        return record;
    }

    private async admit(input: FlowInvocationInput, session: SessionHandle): Promise<FlowInvocationRecord> {
        const key = PREFIX + input.requestId;
        const saved = await session.getShared(key);
        let record = saved?.value as unknown as FlowInvocationRecord | undefined;
        if (record) this.assertSame(record, input);
        else {
            const flow = await this.definitions.loadRevision(input.flowId, input.revision);
            if (!flow) throw new Error(`Flow revision not found: ${input.flowId}@${input.revision}`);
            const issues = validateFlowParameters(flow.parameters, input.parameters);
            for (const name of Object.keys(input.parameters)) if (!(flow.parameters ?? []).some(field => field.name === name)) throw new Error(`Unknown Flow parameter: ${name}`);
            if (issues.length) throw new Error(issues.map(issue => issue.message).join('; '));
            record = { ...input, resolvedConnectionId: await this.resolveConnection?.(input.sessionId, input.connectionId) ?? null, flow, createdAt: Date.now(), ...await this.source?.(input.sessionId) };
            await session.setShared(key, json(record), { expectedVersion: null });
        }
        return record;
    }

    private findRoot(tasks: TaskRecord[], requestId: string): TaskRecord | undefined {
        return tasks.find(task => task.labels?.kind === 'flow-root'
            && (task.input as { initialScheduler?: { spec?: DagRunSpec } })?.initialScheduler?.spec?.invocation?.requestId === requestId);
    }

    private assertSame(record: FlowInvocationRecord, input: FlowInvocationInput): void {
        if (record.connectionId !== input.connectionId || record.flowId !== input.flowId || record.revision !== input.revision || canonical(record.parameters) !== canonical(input.parameters)) {
            throw new Error('Flow invocation request id was already used with different arguments');
        }
    }

    private async assertWritable(sessionId: string): Promise<void> {
        if (this.canWrite && !await this.canWrite(sessionId)) throw new Error('Session is owned by another host');
        const status = await this.kernel.sessionStat(sessionId);
        if (status.phase !== 'open' || status.archived) throw new Error('Session is not open');
    }
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return JSON.stringify(value);
}
