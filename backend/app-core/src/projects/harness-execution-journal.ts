import { sha256HexSync } from '@itookit/common';
import type { EffectExecutionContext, EffectSessionState, JsonValue } from '@itookit/durable-kernel';
import type { HarnessExecutionRequest, HarnessExecutionResult } from '@itookit/kernel-adapters/contracts';
import { canonical } from './harness-connection-policy';

export interface NativeOperation { requestId: string; outcome: 'pending' | 'committed' | 'not-committed'; result?: JsonValue; code?: string }
export interface NativeText { id: string; text: string }
export interface ExecutionJournalData {
    version: 1; owner: string[]; fingerprint: string; epoch: string;
    sessionId?: string; turnId?: string; operations: Record<string, NativeOperation>;
    cursor?: { after: number; eventEpoch: string }; texts: NativeText[]; notified: string[];
    terminal?: 'completed' | 'failed' | 'cancelled'; outputChecked?: boolean; result?: HarnessExecutionResult;
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
    async load(): Promise<boolean> {
        const saved = await this.state.get(this.key);
        if (!saved) return false;
        const data = saved.value as unknown as ExecutionJournalData;
        if (!data || data.version !== 1 || canonical(data.owner) !== canonical(identity(this.context))
            || data.fingerprint !== sha256HexSync(canonical(this.request)) || typeof data.epoch !== 'string'
            || !data.operations || !Array.isArray(data.texts) || !Array.isArray(data.notified)) throw executionError('JOURNAL_CONFLICT');
        this.data = data; this.revision = saved.version;
        return true;
    }
    async initialize(epoch: string): Promise<void> {
        this.data = { version: 1, owner: identity(this.context), fingerprint: sha256HexSync(canonical(this.request)),
            epoch, operations: {}, texts: [], notified: [] };
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
