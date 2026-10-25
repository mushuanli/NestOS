import { randomUUID, sha256HexSync } from '@itookit/common';
import type { EffectExecutionContext, EffectSessionState, JsonValue } from '@itookit/durable-kernel';
import type {ContextBinding, ContextBindingOperation, ContextBindingRef, HarnessExecutionRequest, HarnessExecutionResult} from '@itookit/kernel-adapters/contracts';
import { canonical } from './harness-connection-policy';

export interface NativeOperation { requestId: string; outcome: 'pending' | 'committed' | 'not-committed'; result?: JsonValue; code?: string }
export interface NativeText { id: string; text: string }
export interface ExecutionJournalData {
    version: 1; owner: string[]; fingerprint: string; epoch: string;
    sessionId?: string; turnId?: string; operations: Record<string, NativeOperation>;
    cursor?: { after: number; eventEpoch: string }; texts: NativeText[]; notified: string[];
    terminal?: 'completed' | 'failed' | 'cancelled'; outputChecked?: boolean; result?: HarnessExecutionResult;
    bindingId?: string;
    bindingSettlement?: {ref: ContextBindingRef; kind: 'terminal' | 'not-started'; knownHeadRef?: string};
    forkSource?: ContextBinding['forkedFrom'];
    forkRejected?: string;
}
type Identity = Pick<EffectExecutionContext, 'sessionId' | 'taskId' | 'effectId'>;
export function harnessExecutionJournalKey(context: Identity): string {
    return `harness.execution.${sha256HexSync(JSON.stringify(identity(context)))}`;
}
export function nativeOperationId(context: Identity, step: string): string {
    return `he_${sha256HexSync(JSON.stringify([...identity(context), step]))}`;
}
function identity(context: Identity): string[] { return [context.sessionId, context.taskId, context.effectId]; }
export function executionError(code: string): Error & { code: string } {
    return Object.assign(new Error(`Harness execution: ${code}`), { code });
}
export function jsonValue(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

/** A single Effect-owned CAS record precedes every native mutation. */
export class ExecutionJournal {
    private revision: number | null = null;
    data!: ExecutionJournalData;
    readonly key: string;
    constructor(readonly state: EffectSessionState, readonly context: Identity, private readonly request: HarnessExecutionRequest) {
        this.key = harnessExecutionJournalKey(context);
    }
    withState(state: EffectSessionState): ExecutionJournal {return new ExecutionJournal(state, this.context, this.request);}
    contextOperation(): ContextBindingOperation {
        if (!this.request.context) throw executionError('CONTEXT_INVOCATION_REQUIRED');
        return {operationId: nativeOperationId(this.context, 'context-binding'), invocationId: this.request.context.invocationId,
            fingerprint: this.data.fingerprint, executionRef: {taskId: this.context.taskId, effectId: this.context.effectId}};
    }
    async load(): Promise<boolean> {
        const saved = await this.state.get(this.key);
        if (!saved) return false;
        const data = saved.value as unknown as ExecutionJournalData;
        if (!validJournalData(data, this.context, this.request)) throw executionError('JOURNAL_CONFLICT');
        if (this.request.context && !validBindingJournal(data)) throw executionError('JOURNAL_CONFLICT');
        if (!validForkJournal(data, this.request)) throw executionError('JOURNAL_CONFLICT');
        this.data = data; this.revision = saved.version;
        return true;
    }
    async initialize(epoch: string): Promise<void> {
        this.data = { version: 1, owner: identity(this.context), fingerprint: sha256HexSync(canonical(this.request)),
            epoch, operations: {}, texts: [], notified: [], ...(this.request.context ? {bindingId: `cb_${randomUUID()}`} : {}) };
        await this.save({});
    }
    async save(update: Partial<ExecutionJournalData>): Promise<void> {
        const next = { ...this.data, ...update };
        const saved = await this.state.set(this.key, jsonValue(next), this.revision);
        this.data = next; this.revision = saved.version;
    }
    async operation(step: string, value: NativeOperation): Promise<void> {
        await this.save({ operations: { ...this.data.operations, [step]: value } });
    }
    /** Admission and pause share one Kernel transaction; previously admitted work may settle. */
    async operationIfRunning(step: string, value: NativeOperation): Promise<boolean> {
        if (!this.state.setIfRunning) throw executionError('NATIVE_CONTINUATION_GUARD_UNAVAILABLE');
        const next = { ...this.data, operations: { ...this.data.operations, [step]: value } };
        const saved = await this.state.setIfRunning(this.key, jsonValue(next), this.revision);
        if (!saved) return false;
        this.data = next; this.revision = saved.version;
        return true;
    }
}

function validJournalData(data: ExecutionJournalData, context: Identity, request: HarnessExecutionRequest): boolean {
    return !!data && data.version === 1 && canonical(data.owner) === canonical(identity(context))
        && data.fingerprint === sha256HexSync(canonical(request)) && typeof data.epoch === 'string'
        && !!data.operations && Array.isArray(data.texts) && Array.isArray(data.notified);
}

function validBindingJournal(data: ExecutionJournalData): boolean {
    if (typeof data.bindingId !== 'string' || !data.bindingId) return false;
    const settlement = data.bindingSettlement;
    if (!settlement) return true;
    const ref = settlement.ref;
    if (!validBindingReceiptRef(ref, data.bindingId) || !validBindingSettlement(data, settlement)) return false;
    return !data.result || canonical(data.result.contextBinding) === canonical(ref);
}
function validBindingReceiptRef(ref: ContextBindingRef, id: string): boolean {
    return ref?.bindingId === id && [ref.revision, ref.generation].every(value => Number.isSafeInteger(value) && value > 0);
}
function validBindingSettlement(data: ExecutionJournalData, settlement: NonNullable<ExecutionJournalData['bindingSettlement']>): boolean {
    if (settlement.kind === 'terminal' && (!data.terminal || !data.turnId || settlement.knownHeadRef !== data.turnId)) return false;
    return ['terminal', 'not-started'].includes(settlement.kind);
}

function validForkJournal(data: ExecutionJournalData, request: HarnessExecutionRequest): boolean {
    const selected = request.context?.conversation;
    if (!validForkRejection(data)) return false;
    if (selected?.mode !== 'fork') return !data.forkSource && !data.operations.fork && !data.forkRejected;
    if (data.operations.create || data.operations.fork && !data.forkSource) return false;
    return !data.forkSource || forkSourceMatches(data.forkSource, selected, request.connection, data.epoch);
}
function validForkRejection(data: ExecutionJournalData): boolean {
    if (!data.forkRejected) return true;
    return typeof data.forkRejected === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(data.forkRejected)
        && !data.turnId && !data.operations.turn && data.operations.fork?.outcome === 'committed';
}
function forkSourceMatches(source: NonNullable<ExecutionJournalData['forkSource']>, selected: Extract<NonNullable<HarnessExecutionRequest['context']>['conversation'], {mode: 'fork'}>,
    connection: HarnessExecutionRequest['connection'], epoch: string): boolean {
    return source.bindingId === selected.sourceBindingId && source.revision === selected.expectedBindingRevision
        && source.generation === selected.expectedGeneration && source.checkpointRef === selected.checkpointRef
        && source.nativeRef?.epoch === epoch && source.nativeRef.nodeConnectionId === connection.nodeConnectionId
        && source.nativeRef.profileId === connection.profileId && typeof source.nativeRef.sessionId === 'string' && !!source.nativeRef.sessionId;
}
