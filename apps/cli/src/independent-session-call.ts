import type {ApplicationClient} from '@itookit/app-contracts/services';
import {IndependentCallCommand, type IndependentCallInput, type IndependentCallReceipt} from '@itookit/llm-session/contracts';
import type {CommandOptions} from './commands';
import {assertFrozenCallOptions, prepareSessionSubmission, readCallJson, validateSubmissionFile, writeCallJson} from './application-submission';
import {watchSubmissionExecution} from './submission-execution';
import {recordRuntimeDiagnostic} from './diagnostics';

/** CLI owns files and observation; the host alone chooses and admits the execution Session. */
export async function independentSessionCall(client: ApplicationClient, action: string, sessionId: string, value: string | undefined, options: CommandOptions): Promise<unknown> {
    if (action === 'call-prepare') return prepare(client, sessionId, value, options);
    assertFrozenCallOptions(options);
    if (options.callTitle || options.transferFile || action === 'call-receipt' && options.follow)
        throw failure('CLI_CALL_OPTIONS_CONFLICT', 'Frozen calls cannot override title or materials; --follow is only valid for call-submit');
    if (!value) throw failure('CLI_CALL_FILE_REQUIRED', 'An independent call file is required');
    const input = readInput(await readCallJson(value), sessionId);
    const receipt = await dispatch(client, input, action === 'call-receipt');
    if (action === 'call-receipt' || receipt.status !== 'accepted' || options.connect && !options.follow) return receipt;
    return observe(client, input, receipt, options.follow);
}

async function prepare(client: ApplicationClient, sessionId: string, text: string | undefined, options: CommandOptions) {
    const started = Date.now();
    if (!options.submissionFile || !options.callTitle?.trim())
        throw failure('CLI_CALL_OPTIONS_REQUIRED', 'call-prepare requires --submission-file and --call-title');
    if (options.follow) throw failure('CLI_CALL_OPTIONS_CONFLICT', 'Preparation does not execute or follow a call');
    const manifest = await client.services.sessionRepository.getManifest(sessionId), branch = options.branch ?? manifest.currentBranch;
    if (!Object.hasOwn(manifest.branches, branch)) throw failure('CLI_CALL_BRANCH_INVALID', 'Preparation branch does not exist');
    const request = await prepareSessionSubmission(client, sessionId, text, branch, {...options, submissionFile: undefined});
    const transfer = options.transferFile ? await readCallJson(options.transferFile) : undefined;
    const input = readInput({request, title: options.callTitle, ...(transfer !== undefined ? {transfer} : {})}, sessionId);
    await writeCallJson(options.submissionFile, input, request.submission!.id);
    recordRuntimeDiagnostic('call.independent.prepared', {operation: 'session.call.prepare', operationId: request.submission!.id, stage: 'file-write', outcome: 'prepared', persisted: true, durationMs: Date.now() - started});
    return {operationId: request.submission!.id, target: request.expectedTarget, submissionFile: options.submissionFile, prepared: true, independent: true};
}

function readInput(value: unknown, sessionId: string): IndependentCallInput {
    const input = value as IndependentCallInput;
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 4096
        || Object.keys(input).some(key => !['title', 'request', 'transfer'].includes(key))) throw failure('CLI_CALL_INPUT_INVALID', 'Expected an independent call object with a title and frozen request');
    validateSubmissionFile(input.request, sessionId);
    if (!input.request.expectedTarget || !input.request.expectedBranch)
        throw failure('CLI_CALL_IDENTITY_REQUIRED', 'Independent calls require a published target and explicit caller branch');
    if (input.transfer !== undefined && (!input.transfer || typeof input.transfer !== 'object'
        || Object.keys(input.transfer).some(key => !['sessionId', 'id'].includes(key))
        || ![input.transfer.sessionId, input.transfer.id].every(ref => typeof ref === 'string' && !!ref.trim())))
        throw failure('CLI_CALL_TRANSFER_INVALID', 'Expected a content transfer reference with sessionId and id');
    return structuredClone(input);
}

async function dispatch(client: ApplicationClient, input: IndependentCallInput, inspect: boolean): Promise<IndependentCallReceipt> {
    const operationId = input.request.submission!.id, started = Date.now(), stage = inspect ? 'lookup' : 'admission';
    try {
        const receipt = await client.services.commandBus.execute<IndependentCallReceipt>(inspect ? IndependentCallCommand.Inspect : IndependentCallCommand.Submit, input);
        if (!receipt || receipt.operationId !== operationId || receipt.callerSessionId !== input.request.expectedSessionId
            || !['unknown', 'accepted'].includes(receipt.status) || receipt.status === 'accepted' && !receipt.executionSessionId)
            throw failure('CLI_CALL_RECEIPT_MISMATCH', 'Independent call receipt does not match the frozen request');
        recordRuntimeDiagnostic('call.independent', {operationId, stage, outcome: receipt.status, durationMs: Date.now() - started});
        return receipt;
    } catch (error) {
        const supplied = (error as {code?: unknown})?.code;
        const code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CLI_CALL_FAILED';
        recordRuntimeDiagnostic('call.independent', {operationId, stage, outcome: 'failure', code, durationMs: Date.now() - started});
        throw error;
    }
}

async function observe(client: ApplicationClient, input: IndependentCallInput, receipt: IndependentCallReceipt, follow = false) {
    const started = Date.now(); let stage = 'view-open';
    let opened: Awaited<ReturnType<typeof client.backend.openSessionView>> | undefined;
    try {
        opened = await client.backend.openSessionView(receipt.executionSessionId!);
        await opened.activate(); stage = 'execution';
        const request = {...input.request, expectedSessionId: receipt.executionSessionId, expectedBranch: 'main',
            submission: {id: receipt.operationId, source: {kind: 'independent-call', ownerId: receipt.callerSessionId, id: receipt.operationId}}};
        const watching = watchSubmissionExecution(client, request, follow);
        try {
            const execution = await watching.wait();
            recordRuntimeDiagnostic('call.independent.observe', {operationId: receipt.operationId, stage, outcome: execution.status, durationMs: Date.now() - started});
            return {...receipt, admission: receipt.status, executionRef: receipt.execution, execution, waitingForInput: execution.waitingForInput};
        } finally {watching.dispose();}
    } catch (error) {
        const supplied = (error as {code?: unknown})?.code;
        const code = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(supplied) ? supplied : 'CLI_CALL_OBSERVATION_FAILED';
        recordRuntimeDiagnostic('call.independent.observe', {operationId: receipt.operationId, stage, outcome: 'failure', code, durationMs: Date.now() - started});
        throw error;
    } finally {await opened?.dispose();}
}

function failure(code: string, message: string): Error {return Object.assign(new Error(message), {code});}
