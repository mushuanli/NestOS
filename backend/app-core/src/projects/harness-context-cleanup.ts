import {createModuleLogger} from '@itookit/common';
import type {EffectExecutionContext, Kernel} from '@itookit/durable-kernel';
import type {ContextBinding} from '@itookit/kernel-adapters/contracts';
import {harnessCleanupRecord} from './harness-cleanup-state';
import {CONTEXT_BINDINGS_KEY, HarnessContextBindings} from './harness-context-bindings';
import {settleExecutionContext, type ContextBindingSettlementPort} from './harness-execution-context';
import {executionError, harnessExecutionJournalKey, type ExecutionJournal} from './harness-execution-journal';
import type {HarnessExecutionOptions} from './harness-execution';
import {canonical} from './harness-connection-policy';

type Cleanup = NonNullable<HarnessExecutionOptions['settleContextForCleanup']>;
type KernelSource = () => Pick<Kernel, 'openSession'>;
type WriteGate = (sessionId: string) => Promise<void>;
const log = createModuleLogger('HarnessContextCleanup');

/** The host grants settlement methods, never a collection write port to the cancelled Effect. */
export function createHarnessContextCleanup(kernel: KernelSource, ensureWritable: WriteGate = async () => {}): Cleanup {
    return (journal, unstarted, context) => cleanup(kernel, ensureWritable, journal, unstarted, context);
}

async function cleanup(kernel: KernelSource, ensureWritable: WriteGate, journal: ExecutionJournal, unstarted: boolean, context: EffectExecutionContext) {
    const started = Date.now(); let stage = 'journal-verification';
    try {
        if (harnessExecutionJournalKey(context) !== journal.key) throw executionError('CLEANUP_CONTEXT_MISMATCH');
        await ensureWritable(context.sessionId);
        const session = await kernel().openSession(context.sessionId);
        const owned = journal.withState(harnessCleanupRecord(session, context.sessionId, journal.key, ensureWritable));
        if (!await owned.load()) throw executionError('CLEANUP_JOURNAL_MISSING');
        assertOutcomeProof(owned, unstarted);
        const state = harnessCleanupRecord(session, context.sessionId, CONTEXT_BINDINGS_KEY, ensureWritable);
        const store = new HarnessContextBindings(state, context.sessionId);
        const port = settlementPort(store, owned, unstarted, next => {stage = next;});
        const result = await settleExecutionContext(owned, unstarted, port);
        report(context, 'settled', started); return result;
    } catch (error) {report(context, stage, started, error); throw error;}
}

function settlementPort(store: HarnessContextBindings, journal: ExecutionJournal, unstarted: boolean, stage: (value: string) => void): ContextBindingSettlementPort {
    const id = journal.data.bindingId!, operationId = journal.contextOperation().operationId;
    return {
        get: async () => {stage('binding-read'); return store.get(id);},
        prepare: async settlement => {
            stage('binding-ownership'); assertOwner(await store.get(id), journal);
            stage('binding-prepare'); const result = await store.prepareSettlement(id, operationId, settlement);
            stage('journal-persistence'); return result;
        },
        release: async revision => {
            stage('release-proof');
            if (!await journal.load()) throw executionError('CLEANUP_JOURNAL_MISSING');
            assertOutcomeProof(journal, unstarted); assertReleaseProof(journal, id, revision);
            const current = await store.get(id);
            if (current && current.revision >= revision && current.activeOperation?.operationId !== operationId) return current;
            assertOwner(current, journal);
            assertPreparedProof(current!, journal);
            stage('binding-release'); return store.release(id, operationId, revision);
        },
    };
}

function assertOwner(binding: ContextBinding | undefined, journal: ExecutionJournal): void {
    if (!binding || canonical(binding.activeOperation) !== canonical(journal.contextOperation())) throw executionError('CLEANUP_BINDING_OWNER_MISMATCH');
    if (binding.nativeRef && (binding.nativeRef.sessionId !== journal.data.sessionId || binding.nativeRef.epoch !== journal.data.epoch))
        throw executionError('CLEANUP_NATIVE_IDENTITY_MISMATCH');
}

function assertOutcomeProof(journal: ExecutionJournal, unstarted: boolean): void {
    const data = journal.data;
    if (!unstarted) {
        if (!['completed', 'failed', 'cancelled'].includes(data.terminal ?? '') || !data.turnId || !data.sessionId)
            throw executionError('CLEANUP_BINDING_STOP_UNCONFIRMED');
        return;
    }
    if (data.terminal || data.turnId || data.operations.turn?.outcome === 'committed'
        || Object.values(data.operations).some(operation => operation.outcome === 'pending')) throw executionError('CLEANUP_BINDING_START_UNCONFIRMED');
}

function assertReleaseProof(journal: ExecutionJournal, id: string, revision: number): void {
    const saved = journal.data.bindingSettlement;
    if (!saved || saved.ref.bindingId !== id || saved.ref.revision !== revision) throw executionError('CLEANUP_BINDING_RECEIPT_INVALID');
}

function assertPreparedProof(binding: ContextBinding, journal: ExecutionJournal): void {
    const saved = journal.data.bindingSettlement!, prepared = binding.settlement;
    if (binding.generation !== saved.ref.generation || !prepared || prepared.kind !== saved.kind
        || prepared.knownHeadRef !== saved.knownHeadRef) throw executionError('CLEANUP_BINDING_RECEIPT_INVALID');
}

function report(context: EffectExecutionContext, stage: string, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const fields = {operation: 'harness.context.cleanup', operationId: harnessExecutionJournalKey(context),
        sessionId: context.sessionId, taskId: context.taskId, effectId: context.effectId, stage,
        result: error ? 'failure' : 'success', durationMs: Date.now() - started,
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : error ? 'CLEANUP_BINDING_FAILED' : undefined};
    if (error) log.warn('Harness context cleanup', fields); else log.info('Harness context cleanup', fields);
}
