import type { JsonValue, DagRunSpec } from '@itookit/llm-flow/contracts';
import {assertRootCallable, isTargetRef, sameTargetRef} from '@itookit/llm-flow/contracts';
import {flowTargetRef} from './flow-target';
import type { ICommandBus } from '../contracts';
import type { Kernel, SessionHandle } from '@itookit/durable-kernel';
import {simpleHash} from '@itookit/llm-context';
import { FlowCommand, FlowDefinitionStore, prepareFlowCallInput, type DagCommandService } from '@itookit/llm-flow';
import type { ContentTransferService } from './content-transfers';
import { createSessionHost, type SessionHostPorts } from '../utils/host-ports';
import type { FlowInvocationSessions } from '../persistence/flow-invocation-sessions';

import { FlowInvocationCommand, flowInvocationId, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
import {FLOW_INVOCATION_PREFIX, flowInvocationRequest, assertFlowRerun, findFlowInvocationRoot} from './flow-invocation-identity';
import {ulid} from '../persistence/ulid';
export { FlowInvocationCommand, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
const PREFIX = FLOW_INVOCATION_PREFIX;
/** Shared records already read by a caller, so recovery does not list them twice. */
type StoredInvocations = Awaited<ReturnType<Kernel['listShared']>>;

/** Calls live beside chat history; their completion never moves the conversation head. */
export class FlowInvocationService {
    private pending = new Map<string, Promise<FlowInvocationRecord>>();
    constructor(private kernel: Kernel, private definitions: FlowDefinitionStore, private commands: ICommandBus,
        private canWrite?: (id: string) => Promise<boolean>,
        private source?: (id: string) => Promise<{ branch: string; head: string | null; parentSessionId?: string }>,
        private resolveConnection?: (sessionId: string, connectionId?: string) => Promise<string | undefined>,
        private invocationSessions?: FlowInvocationSessions,
        private runs?: Pick<DagCommandService, 'prepareRun' | 'submitPrepared'>,
        private transfers?: Pick<ContentTransferService, 'read'> & Partial<Pick<ContentTransferService, 'createChild'>>, private hostPorts?: SessionHostPorts) {}

    register(): void {
        this.commands.register(FlowInvocationCommand.Invoke, args => this.invoke(args as FlowInvocationInput));
        this.commands.register(FlowInvocationCommand.List, args => this.list((args as { sessionId: string }).sessionId));
    }

    async invoke(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        input = flowInvocationRequest(input);
        const key = `${input.sessionId}/${input.requestId}`;
        const previous = this.pending.get(key);
        if (previous) { const record = await previous; this.assertSame(record, input); return record; }
        const operation = this.traceAdmission(structuredClone(input));
        this.pending.set(key, operation);
        try { return await operation; } finally { this.pending.delete(key); }
    }

    async list(sessionId: string, stored?: StoredInvocations): Promise<FlowInvocationRecord[]> {
        const entries = stored ?? await this.kernel.listShared(sessionId, PREFIX);
        if (entries.length === 0) return [];
        const session = await this.kernel.inspectSession(sessionId);
        const tasks = await session.listTasks();
        return (await Promise.all(entries.map(async entry => {
            const record = entry.value as unknown as FlowInvocationRecord;
            this.assertIdentity(record, sessionId);
            const executionTasks = record.executionSessionId
                ? await (await this.kernel.inspectSession(record.executionSessionId)).listTasks() : tasks;
            const root = findFlowInvocationRoot(executionTasks, record);
            const childError = !root && record.executionSessionId
                ? await this.childAdmissionError(record) : undefined;
            return { ...record, ...(root ? { rootTaskId: root.id, error: undefined } : childError ? {error: childError} : {}) };
        }))).sort((a, b) => a.createdAt - b.createdAt);
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
                    if (record.execution === 'child' && !record.error) {
                        const routed = await this.invoke(record);
                        if (routed.rootTaskId) await this.commands.execute(FlowCommand.RunResume,
                            {sessionId: routed.executionSessionId, taskId: routed.rootTaskId});
                        continue;
                    }
                    if (!record.rootTaskId && !record.error) await this.invoke(record);
                    else if (record.rootTaskId) {
                        if (record.preparedGraph) {
                            await this.assertWritable(session.id);
                            await this.saveRoot(await this.kernel.openSession(session.id), record, record.rootTaskId);
                        }
                        await this.commands.execute(FlowCommand.RunResume, { sessionId: record.executionSessionId ?? session.id, taskId: record.rootTaskId });
                    }
                } catch (error) { console.error('Flow invocation recovery failed', session.id, record.requestId, error); }
            }
        }
        // Seal a probe that covered every Session, so later boots take the cheap path even when
        // no Session holds a call. An incomplete pass stays unknown and is probed again.
        if (marker && marked === undefined && complete) await marker.establish(found);
    }

    private async submit(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        await this.assertWritable(input.sessionId);
        if (input.execution === 'child' && !this.transfers?.createChild) throw new Error('Independent Flow calls are unavailable');
        // Mark the Session before its first invocation record is written, so a later boot knows
        // which Sessions to scan. A mark failure surfaces here instead of hiding a lost resume.
        await this.invocationSessions?.mark(input.sessionId);
        const session = await this.kernel.openSession(input.sessionId), key = PREFIX + input.requestId;
        let record = await this.admit(input, session);
        if (record.execution === 'child') return this.submitChild(session, record);
        const existing = findFlowInvocationRoot(await session.listTasks(), record);
        if (existing) return this.saveRoot(session, record, existing.id);
        // Upgrade older intents only when no durable root already owns their graph.
        if (this.runs && !record.preparedGraph) {
            record = await this.prepare(record);
            await session.setShared(key, json(record));
        }
        try {
            await this.assertWritable(input.sessionId);
            const { taskId } = await this.start(record);
            return await this.saveRoot(session, record, taskId);
        } catch (error) {
            const root = findFlowInvocationRoot(await session.listTasks(), record);
            if (root) return this.saveRoot(session, record, root.id);
            await session.setShared(key, json({ ...record, error: String(error) }));
            throw error;
        }
    }

    private async childAdmissionError(parent: FlowInvocationRecord): Promise<string | undefined> {
        const child = await this.kernel.inspectSession(parent.executionSessionId!);
        const stored = await child.getShared(PREFIX + parent.requestId);
        if (!stored) return;
        const record = stored.value as unknown as FlowInvocationRecord;
        this.assertIdentity(record, parent.executionSessionId!);
        if (record.invocationId !== parent.invocationId || record.callerSessionId !== parent.sessionId)
            throw new Error('Independent Flow invocation identity conflict');
        return record.error;
    }

    private async submitChild(parent: SessionHandle, record: FlowInvocationRecord): Promise<FlowInvocationRecord> {
        if (record.executionSessionId) await this.assertWritable(record.executionSessionId);
        const {sessionId} = await this.transfers!.createChild!({sessionId: parent.id, requestId: record.requestId, title: record.flow.name});
        if (record.executionSessionId && record.executionSessionId !== sessionId) throw new Error('Independent Flow Session identity conflict');
        if (!record.executionSessionId) {
            record = {...record, executionSessionId: sessionId};
            await parent.setShared(PREFIX + record.requestId, json(record));
        }
        await this.assertWritable(sessionId);
        await this.invocationSessions?.mark(sessionId);
        const child = await this.kernel.openSession(sessionId);
        const input = {...record, sessionId, execution: undefined, executionSessionId: undefined,
            callerSessionId: parent.id, rootTaskId: undefined, preparedGraph: undefined,
            retryOfSessionId: record.retryOfInvocationId ? record.retryOfSessionId ?? parent.id : undefined};
        await this.saveChildIntent(child, input);
        const result = await this.submit(flowInvocationRequest(input));
        return this.saveRoot(parent, record, result.rootTaskId!);
    }

    private async saveChildIntent(child: SessionHandle, input: FlowInvocationRecord): Promise<void> {
        const key = PREFIX + input.requestId;
        let stored = await child.getShared(key);
        if (!stored) {
            const prepared = await this.prepare(input);
            try {await child.setShared(key, json(prepared), {expectedVersion: null}); return;}
            catch (error) {stored = await child.getShared(key); if (!stored) throw error;}
        }
        const record = stored.value as unknown as FlowInvocationRecord;
        this.assertSame(record, input);
        if (record.invocationId !== input.invocationId || record.callerSessionId !== input.callerSessionId)
            throw new Error('Independent Flow invocation identity conflict');
    }

    private async start(record: FlowInvocationRecord): Promise<{ taskId: string }> {
        const parameters = invocationParameters(record);
        const invocation: DagRunSpec['invocation'] = { requestId: record.requestId, flowId: record.flowId,
            ...(record.target ? {target: structuredClone(record.target)} : {}),
            ...(record.invocationId ? {invocationId: record.invocationId} : {}),
            ...(record.retryOfInvocationId ? {retryOfInvocationId: record.retryOfInvocationId, retryOfSessionId: record.retryOfSessionId ?? record.sessionId} : {}),
            revision: record.flow.revision, digest: record.flow.digest, name: record.flow.name, createdAt: record.createdAt,
            ...(record.branch ? { branch: record.branch, head: record.head } : {}) };
        if (record.preparedGraph) {
            if (!this.runs) throw new Error('Admitted Flow graph requires a compiled run runtime');
            return this.runs.submitPrepared({ kind: 'graph', sessionId: record.sessionId,
                graph: { ...record.preparedGraph, invocation }, parameters });
        }
        return this.commands.execute(FlowCommand.RunStart, { sessionId: record.sessionId, flow: record.flow,
            parameters, invocation, connectionBindings: record.connectionBindings,
            connectionId: record.connectionId, fallbackConnectionId: record.resolvedConnectionId });
    }

    private async saveRoot(session: SessionHandle, record: FlowInvocationRecord, taskId: string): Promise<FlowInvocationRecord> {
        if (record.rootTaskId === taskId && !record.preparedGraph && !record.error) return record;
        const saved = { ...record, rootTaskId: taskId, error: undefined, preparedGraph: undefined };
        await session.setShared(PREFIX + record.requestId, json(saved));
        return saved;
    }

    private async prepare(record: FlowInvocationRecord): Promise<FlowInvocationRecord> {
        if (!this.runs || record.execution === 'child') return record;
        const preparedGraph = await this.runs.prepareRun({ sessionId: record.sessionId, flow: record.flow,
            parameters: invocationParameters(record), connectionId: record.connectionId, connectionBindings: record.connectionBindings,
            fallbackConnectionId: record.resolvedConnectionId ?? null });
        return { ...record, preparedGraph };
    }

    private async admit(input: FlowInvocationInput, session: SessionHandle): Promise<FlowInvocationRecord> {
        const key = PREFIX + input.requestId;
        const saved = await session.getShared(key);
        let record = saved?.value as unknown as FlowInvocationRecord | undefined;
        if (record) this.assertSame(record, input);
        else {
            record = await this.inputRecord(input);
            record = await this.prepare(record);
            try {await session.setShared(key, json(record), { expectedVersion: null });}
            catch (error) {
                const winner = await session.getShared(key);
                if (!winner) throw error;
                record = winner.value as unknown as FlowInvocationRecord; this.assertSame(record, input);
            }
        }
        return record;
    }

    private async inputRecord(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        const loaded = await this.definitions.loadRevision(input.flowId, input.revision);
        if (!loaded) throw new Error(`Flow revision not found: ${input.flowId}@${input.revision}`);
        const flow = structuredClone(loaded);
        assertRootCallable(flow);
        if (input.source && Object.keys(input.parameters).length) throw new Error('Flow parameters and source cannot both be supplied');
        const inputResolution = prepareFlowCallInput(flow, input.source ?? {kind: 'arguments', value: input.parameters}, {expected: input.expectedSignature});
        const location = await this.source?.(input.sessionId);
        await assertFlowRerun(this.kernel, input, location?.parentSessionId);
        const inputTransfers = await this.bindInputs({...input, parameters: inputResolution.parameters});
        return {...input, invocationId: ulid(), target: flowTargetRef(flow), inputResolution, inputResolutionDigest: simpleHash(canonical(inputResolution)),
            ...(inputTransfers ? {inputTransfers} : {}), resolvedConnectionId: await this.resolveConnection?.(input.sessionId, input.connectionId) ?? null,
            flow, createdAt: Date.now(), ...(location ? {branch: location.branch, head: location.head} : {})};
    }

    private async bindInputs(input: FlowInvocationInput): Promise<FlowInvocationRecord['inputTransfers']> {
        if (!input.inputSources || !Object.keys(input.inputSources).length) return;
        if (!this.transfers) throw new Error('CONTENT_TRANSFER_UNAVAILABLE');
        const result: NonNullable<FlowInvocationRecord['inputTransfers']> = Object.create(null);
        for (const [name, reference] of Object.entries(input.inputSources)) {
            const transfer = await this.transfers.read(reference, input.sessionId);
            if (!Object.hasOwn(input.parameters, name) || canonical(input.parameters[name]) !== canonical(transfer.value))
                throw new Error('CONTENT_PARAMETER_MISMATCH');
            result[name] = transfer;
        }
        return result;
    }

    private async traceAdmission(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        const started = Date.now(), logger = createSessionHost(this.hostPorts).logger;
        const metadata = {operation: 'flow.invoke', stage: 'admission', sessionId: input.sessionId, operationId: input.requestId,
            flowId: input.flowId, revision: input.revision, parameterCount: Object.keys(input.parameters).length, sourceCount: Object.keys(input.inputSources ?? {}).length};
        try {
            const record = await this.submit(input);
            logger.info('Flow invocation admitted', {...metadata, outcome: 'success', taskId: record.rootTaskId,
                invocationId: flowInvocationId(record), retryOfInvocationId: record.retryOfInvocationId, executionSessionId: record.executionSessionId,
                resolvedParameterCount: Object.keys(invocationParameters(record)).length, inputSource: input.source?.kind ?? 'arguments', durationMs: Date.now() - started});
            return record;
        } catch (error) {
            const value = (error as {code?: unknown} | null)?.code;
            const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value
                : error instanceof Error && /^CONTENT_[A-Z_]+$/.test(error.message) ? error.message : 'FLOW_ADMISSION_FAILED';
            logger.error('Flow invocation admission failed', {...metadata, outcome: 'failure', errorCode: code,
                errorClass: error instanceof Error ? error.name : typeof error, durationMs: Date.now() - started});
            throw error;
        }
    }

    private assertSame(record: FlowInvocationRecord, input: FlowInvocationInput): void {
        this.assertIdentity(record, input.sessionId);
        invocationParameters(record);
        if (record.execution !== input.execution || record.requestId !== input.requestId || record.retryOfInvocationId !== input.retryOfInvocationId || record.retryOfSessionId !== input.retryOfSessionId
            || canonical(record.source ?? null) !== canonical(input.source ?? null) || canonical(record.expectedSignature ?? null) !== canonical(input.expectedSignature ?? null)
            || canonical(record.inputSources ?? {}) !== canonical(input.inputSources ?? {}) || canonical(record.connectionBindings ?? {}) !== canonical(input.connectionBindings ?? {}) || record.connectionId !== input.connectionId || record.flowId !== input.flowId || record.revision !== input.revision || canonical(record.parameters) !== canonical(input.parameters)) {
            throw new Error('Flow invocation request id was already used with different arguments');
        }
    }

    private assertIdentity(record: FlowInvocationRecord, sessionId: string): void {
        if (!record || record.sessionId !== sessionId || typeof record.requestId !== 'string' || !/^[\w-]{1,128}$/.test(record.requestId)
            || record.invocationId !== undefined && (typeof record.invocationId !== 'string' || !record.invocationId)
            || record.target !== undefined && (!isTargetRef(record.target) || !sameTargetRef(record.target, flowTargetRef(record.flow))))
            throw Object.assign(new Error('Stored Flow invocation identity is invalid'), {code: 'FLOW_INVOCATION_STORAGE_INVALID'});
    }

    private async assertWritable(sessionId: string): Promise<void> {
        if (this.canWrite && !await this.canWrite(sessionId)) throw new Error('Session is owned by another host');
        const status = await this.kernel.sessionStat(sessionId);
        if (status.phase !== 'open' || status.archived) throw new Error('Session is not open');
    }
}

function invocationParameters(record: FlowInvocationRecord): Record<string, JsonValue> {
    if (!record.inputResolution) return record.parameters;
    if (record.inputResolution.version !== 1 || record.inputResolutionDigest !== simpleHash(canonical(record.inputResolution)))
        throw Object.assign(new Error('Flow input resolution is invalid; restore the admitted snapshot'), {code: 'FLOW_INPUT_RESOLUTION_CONFLICT'});
    return record.inputResolution.parameters;
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return JSON.stringify(value);
}
