import type {OperationLedger, OperationReceipt} from '@itookit/llm-ui';
import {SessionCommand, type SessionInstructionQueue, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {createModuleLogger, t} from '@itookit/common';
import type {CommandContext} from './CommandContext';

const log = createModuleLogger('workspace-submission');

/** The existing operation ledger records input before dispatch; queue acceptance can beat a suspended RPC. */
export async function submitSessionCall(ctx: CommandContext, request: SubmissionRequest, key: string): Promise<string> {
    const operationId = request.submission!.id, sessionId = ctx.getSessionId(), ledger = submissionLedger(ctx);
    request = structuredClone({...request, expectedSessionId: sessionId});
    const previous = ledger.getSnapshot().find(record => record.context.operationId === operationId);
    if (previous) {
        const saved = structuredClone(previous.input) as {request?: unknown};
        if (canonicalSubmission(saved.request) !== canonicalSubmission(request)) throw failure('CALL_SUBMISSION_CONFLICT');
        return reconcilePreviousCall(ctx, operationId);
    }
    await ledger.register({context: {viewId: sessionId, operationId}, conversationId: sessionId, kind: 'send', status: 'submitting',
        input: JSON.parse(JSON.stringify({key, request}))});
    return dispatch(ctx, request, sessionId, ledger);
}

async function reconcilePreviousCall(ctx: CommandContext, operationId: string): Promise<string> {
    const started = Date.now();
    let receipt: OperationReceipt;
    try {receipt = await reconcileSessionCall(ctx, operationId);}
    catch (error) {
        log.warn('call.receipt', {operationId, stage: 'resubmit-query', result: 'failure',
            code: rejectionCode(error) ?? 'SUBMISSION_RECEIPT_READ_FAILED', durationMs: Date.now() - started});
        throw failure('CALL_SUBMISSION_UNKNOWN', 'unknown');
    }
    if (receipt.status === 'rejected') throw failure('CALL_SUBMISSION_REJECTED', undefined, receipt.message);
    if (receipt.status !== 'accepted') throw failure('CALL_SUBMISSION_UNKNOWN', 'unknown');
    return operationId;
}

function submissionLedger(ctx: CommandContext): OperationLedger {
    const ledger = ctx.operations;
    if (!ledger || !ctx.observeInstructions || !ctx.reconcileSubmission) throw failure('CALL_SUBMISSION_PORT_UNAVAILABLE');
    return ledger;
}

async function dispatch(ctx: CommandContext, request: SubmissionRequest, sessionId: string, ledger: OperationLedger): Promise<string> {
    const operationId = request.submission!.id, started = Date.now();
    return new Promise<string>((resolve, reject) => {
        let release = () => {}, finished = false;
        const fail = (error: unknown) => {release(); reject(error);};
        const complete = (receipt: OperationReceipt) => {
            if (finished) return;
            const actual = ledger.getSnapshot().find(record => record.context.operationId === operationId)!;
            log.info('call.submit', {operationId, stage: 'admission', result: actual.status, durationMs: Date.now() - started});
            finished = true; release();
            if (actual.status === 'accepted') resolve(operationId);
            else reject(failure(receipt.status === 'rejected' ? receipt.code ?? 'CALL_SUBMISSION_REJECTED' : 'CALL_SUBMISSION_UNKNOWN', actual.status === 'unknown' ? 'unknown' : undefined, actual.message));
        };
        const settle = async (receipt: OperationReceipt) => {await ledger.settle(receipt); complete(receipt);};
        release = observeAdmission(ctx, request, sessionId, ledger, () => complete({status: 'accepted', operationId}));
        if (ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted')
            complete({status: 'accepted', operationId});
        else void deliver(ctx, request, settle).catch(fail);
    });
}

async function deliver(ctx: CommandContext, request: SubmissionRequest, settle: (receipt: OperationReceipt) => Promise<void>): Promise<void> {
    const operationId = request.submission!.id;
    try {
        const id = await ctx.commands.execute<string>(SessionCommand.Submit, request);
        if (id !== operationId) throw failure('CALL_SUBMISSION_RECEIPT_MISMATCH', 'unknown');
        await settle({status: 'accepted', operationId});
    } catch (error) {
        if (await accepted(ctx, request).catch(() => false)) return settle({status: 'accepted', operationId});
        const code = rejectionCode(error);
        await settle(code ? {status: 'rejected', operationId, code, message: (error as Error).message}
            : {status: 'unknown', operationId, message: t('callable.submission.unknown')});
    }
}

function observeAdmission(ctx: CommandContext, request: SubmissionRequest, sessionId: string, ledger: OperationLedger, onAccepted: () => void): () => void {
    const operationId = request.submission!.id;
    let closed = false, checking = false, requested = false;
    const stopLedger = ledger.subscribe(() => {
        if (!closed && ledger.getSnapshot().find(record => record.context.operationId === operationId)?.status === 'accepted') onAccepted();
    });
    const check = () => {
        if (closed || checking) return;
        checking = true; requested = false; const started = Date.now();
        void accepted(ctx, request).then(confirmed => {
            if (confirmed && !closed) return ledger.settle({status: 'accepted', operationId});
        }).catch(error => log.warn('call.receipt', {operationId, stage: 'queue-observation', result: 'failure',
            code: rejectionCode(error) ?? 'SUBMISSION_RECEIPT_READ_FAILED', durationMs: Date.now() - started}))
            .finally(() => {checking = false; if (requested) check();});
    };
    const stopQueue = ctx.observeInstructions!(queue => {
        if (closed || !queueAccepted(queue, request, sessionId)) return;
        requested = true; check();
    });
    return () => {closed = true; stopLedger(); stopQueue();};
}

async function accepted(ctx: CommandContext, request: SubmissionRequest): Promise<boolean> {
    if (!ctx.reconcileSubmission) throw failure('CALL_SUBMISSION_PORT_UNAVAILABLE');
    const receipt = await ctx.reconcileSubmission(request);
    if (!receipt || receipt.operationId !== request.submission?.id || !['accepted', 'unknown'].includes(receipt.status))
        throw failure('CALL_SUBMISSION_RECEIPT_MISMATCH', 'unknown');
    return receipt.status === 'accepted';
}

export async function reconcileSessionCall(ctx: CommandContext, operationId: string): Promise<OperationReceipt> {
    const record = ctx.operations?.getSnapshot().find(item => item.context.operationId === operationId && item.kind === 'send');
    const request = structuredClone((record?.input as {request?: SubmissionRequest} | undefined)?.request);
    if (!record || !request || record.conversationId !== ctx.getSessionId()) throw failure('CALL_SUBMISSION_PORT_UNAVAILABLE');
    if (record.status === 'rejected') return {operationId, status: 'rejected', code: 'CALL_SUBMISSION_REJECTED', message: record.message ?? t('callable.submission.rejected')};
    const receipt: OperationReceipt = record.status === 'accepted' || await accepted(ctx, request)
        ? {operationId, status: 'accepted'} : {operationId, status: 'unknown', message: t('callable.submission.unknown')};
    await ctx.operations!.settle(receipt);
    const actual = ctx.operations!.getSnapshot().find(item => item.context.operationId === operationId)!;
    if (actual.status === 'rejected') return {operationId, status: 'rejected', code: 'CALL_SUBMISSION_REJECTED', message: actual.message ?? t('callable.submission.rejected')};
    return receipt;
}

function queueAccepted(queue: SessionInstructionQueue | undefined, request: SubmissionRequest, sessionId: string): boolean {
    const expected = request.submission!;
    return queue?.sessionId === sessionId && queue.items.some(item => item.id === expected.id
        && item.sendIntent?.submission?.id === expected.id && item.sendIntent.submission.source.kind === expected.source.kind
        && item.sendIntent.submission.source.ownerId === expected.source.ownerId && item.sendIntent.submission.source.id === expected.source.id);
}

function failure(code: string, outcome?: 'unknown', message?: string): Error {
    const labels: Partial<Record<string, Parameters<typeof t>[0]>> = {CALL_SUBMISSION_UNKNOWN: 'callable.submission.unknown', CALL_SUBMISSION_CONFLICT: 'callable.submission.conflict',
        CALL_SUBMISSION_PORT_UNAVAILABLE: 'callable.submission.unavailable', CALL_SUBMISSION_REJECTED: 'callable.submission.rejected',
        CALL_SUBMISSION_RECEIPT_MISMATCH: 'callable.submission.receiptMismatch'};
    const label = labels[code];
    return Object.assign(new Error(message ?? (label ? t(label) : code)), {code, outcome});
}
export function canonicalSubmission(value: unknown): string {
    return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
function rejectionCode(error: unknown): string | undefined {
    const code = (error as {code?: unknown; outcome?: string})?.code;
    const contextRejections = ['CONTEXT_TARGET_NOT_HARNESS', 'CONTEXT_NATIVE_WRITE_UNSUPPORTED', 'CONTEXT_POLICY_OVERRIDE_INVALID',
        'CONTEXT_DRAFT_INVALID', 'CONTEXT_DRAFT_SCOPE_CHANGED', 'CONTEXT_DRAFT_SELECTION_CHANGED'];
    return typeof code === 'string' && (contextRejections.includes(code)
        || /^(CALL_TARGET_|CALLABLE_|SUBMISSION_|FLOW_INPUT_|QUEUE_(CONFLICT|READ_ONLY|INVALID|BRANCH_CHANGED))/.test(code)) ? code : undefined;
}
