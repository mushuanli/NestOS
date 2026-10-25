import type {ContextBinding, ContextBindingRef, HarnessExecutionRequest} from '@itookit/kernel-adapters/contracts';
import {assertHarnessContextRequest} from '@itookit/kernel-adapters/contracts';
import {HarnessContextBindings} from './harness-context-bindings';
import {executionError, nativeOperationId, type ExecutionJournal} from './harness-execution-journal';
import type {NativeExecution} from './harness-execution-operations';
import {canonical} from './harness-connection-policy';

/** A cleanup delegate cannot claim, attach or address a different binding. */
export interface ContextBindingSettlementPort {
    get(): Promise<ContextBinding | undefined>;
    prepare(settlement: NonNullable<ContextBinding['settlement']>): Promise<ContextBinding>;
    release(expectedRevision: number): Promise<ContextBinding>;
}

/** Admission does not infer native conditional writes or checkpoint support from resume/fork. */
export function validateExecutionContext(request: HarnessExecutionRequest): void {
    if (!request.context) return;
    try {
        assertHarnessContextRequest(request.context);
        if (request.context.conversation.mode === 'continue') throw executionError('CONTEXT_NATIVE_WRITE_UNSUPPORTED');
    } catch (error) {throw Object.assign(error as Error, {executionOutcome: 'not-started'});}
}

export async function claimExecutionContext(journal: ExecutionJournal, request: HarnessExecutionRequest): Promise<void> {
    if (!request.context) return;
    const store = bindings(journal);
    if ((journal.data.operations.create || journal.data.operations.fork) && !await store.get(journal.data.bindingId!)) throw executionError('CONTEXT_BINDING_NOT_FOUND');
    const binding = await store.claim(journal.data.bindingId!, request.context, request.connection, journal.contextOperation());
    if (binding.forkedFrom && journal.data.forkSource && canonical(binding.forkedFrom) !== canonical(journal.data.forkSource))
        throw executionError('JOURNAL_CONFLICT');
    if (binding.forkedFrom && !journal.data.forkSource) await journal.save({forkSource: binding.forkedFrom});
}

export async function attachExecutionContext(run: NativeExecution): Promise<void> {
    if (!run.journal.data.bindingId || !run.journal.data.sessionId) return;
    await bindings(run.journal).attach(run.journal.data.bindingId, operationId(run.journal), {
        nodeConnectionId: run.request.connection.nodeConnectionId, profileId: run.acquired.profile.id,
        workspaceId: run.acquired.workspaceId, epoch: run.journal.data.epoch, sessionId: run.journal.data.sessionId,
    }, run.journal.data.forkRejected);
}

export async function settleExecutionContext(journal: ExecutionJournal, unstarted = false, supplied?: ContextBindingSettlementPort): Promise<ContextBindingRef | undefined> {
    if (!journal.data.bindingId) return;
    assertSettlementKind(journal, unstarted);
    const store = supplied ?? settlementPort(journal), id = journal.data.bindingId;
    const existing = await store.get();
    if (unclaimedBeforeDispatch(journal, existing, unstarted)) return;
    if (!journal.data.bindingSettlement) {
        const settlement = {operationId: operationId(journal), kind: unstarted ? 'not-started' as const : 'terminal' as const,
            ...(!unstarted ? {knownHeadRef: journal.data.turnId} : {})};
        const binding = await store.prepare(settlement);
        const ref = {bindingId: id, revision: binding.revision + 1, generation: binding.generation};
        await journal.save({bindingSettlement: {ref, kind: settlement.kind, knownHeadRef: settlement.knownHeadRef}});
    }
    await store.release(journal.data.bindingSettlement!.ref.revision);
    return journal.data.bindingSettlement!.ref;
}

function assertSettlementKind(journal: ExecutionJournal, unstarted: boolean): void {
    if (!unstarted && (!journal.data.terminal || !journal.data.turnId)) throw executionError('CONTEXT_TERMINAL_UNCONFIRMED');
    if (journal.data.bindingSettlement && journal.data.bindingSettlement.kind !== (unstarted ? 'not-started' : 'terminal'))
        throw executionError('CONTEXT_SETTLEMENT_CONFLICT');
}

function unclaimedBeforeDispatch(journal: ExecutionJournal, existing: ContextBinding | undefined, unstarted: boolean): boolean {
    const operations = journal.data.operations;
    return !existing && unstarted && !operations.create && !operations.fork && !operations.turn;
}

function settlementPort(journal: ExecutionJournal): ContextBindingSettlementPort {
    const store = bindings(journal), id = journal.data.bindingId!, owner = operationId(journal);
    return {get: () => store.get(id), prepare: settlement => store.prepareSettlement(id, owner, settlement),
        release: revision => store.release(id, owner, revision)};
}

function bindings(journal: ExecutionJournal): HarnessContextBindings {return new HarnessContextBindings(journal.state, journal.context.sessionId);}
function operationId(journal: ExecutionJournal): string {return nativeOperationId(journal.context, 'context-binding');}
