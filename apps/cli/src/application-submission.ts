import {open} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {randomUUID} from '@itookit/common';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand, type RootCallTarget, type RootTargetCatalog, type SubmissionRequest, type SubmissionReceipt} from '@itookit/llm-session/contracts';
import {assertFlowCallSource, assertTargetSelection, type FlowId, type JsonValue} from '@itookit/llm-flow/contracts';
import type {CommandOptions} from './commands';
import {recordRuntimeDiagnostic} from './diagnostics';

const MAX_CALL_BYTES = 1024 * 1024;

/** Translate CLI input into the same signed target and structured source used by the composer. */
export async function prepareSessionSubmission(client: ApplicationClient, sessionId: string, text: string | undefined,
    branch: string, options: CommandOptions): Promise<SubmissionRequest> {
    const operationId = randomUUID(), started = Date.now();
    try {
        const request = await buildSessionSubmission(client, sessionId, text, branch, options, operationId);
        recordRuntimeDiagnostic('call.prepared', {operation: 'session.submit', operationId, stage: 'input', outcome: 'prepared',
            targetKind: request.target.kind, source: request.source.kind, persisted: !!options.submissionFile, durationMs: Date.now() - started});
        return request;
    } catch (error) {recordFailure('session.prepare', operationId, 'input', error, started); throw error;}
}

async function buildSessionSubmission(client: ApplicationClient, sessionId: string, text: string | undefined,
    branch: string, options: CommandOptions, operationId: string): Promise<SubmissionRequest> {
    const {kind, id, selected} = await selectTarget(client, options);
    const source = await callSource(text, options);
    const target = selected?.target;
    const overrides = await callOverrides(selected, options);
    const request: SubmissionRequest = {expectedSessionId: sessionId, expectedBranch: branch, target: {kind, id, ...(target ? {version: target.version} : {})},
        ...(target ? {expectedTarget: {...target}} : {}), source, submission: {id: operationId, source: {kind: 'conversation', ownerId: sessionId, id: operationId}},
        ...(overrides ? {overrides} : {})};
    if (options.submissionFile) await saveSubmission(options.submissionFile, request);
    return request;
}

async function selectTarget(client: ApplicationClient, options: CommandOptions) {
    if (options.agent && options.flow) throw failure('CLI_CALL_TARGET_CONFLICT', 'Choose either --agent or --flow');
    const kind = options.flow ? 'flow' : 'agent', id = options.flow ?? options.agent ?? 'default';
    const catalog = await client.services.commandBus.execute<RootTargetCatalog>(SessionCommand.ListTargets);
    const selected = catalog.entries.find(entry => entry.target.kind === kind && entry.target.id === id);
    if (!selected && (kind !== 'agent' || id !== 'default'))
        throw failure('CALL_TARGET_UNAVAILABLE', 'The selected published call target is unavailable; inspect session targets');
    return {kind, id, selected} as const;
}

async function callSource(text: string | undefined, options: CommandOptions) {
    const value = options.paramsFile ? await readJson(options.paramsFile) : {};
    const source = text === undefined ? {kind: 'arguments' as const, value: value as JsonValue}
        : {kind: 'composer' as const, text, values: value as Record<string, JsonValue>, attachments: []};
    assertFlowCallSource(source);
    return source;
}

async function callOverrides(selected: RootCallTarget | undefined, options: CommandOptions): Promise<SubmissionRequest['overrides']> {
    const overrides: NonNullable<SubmissionRequest['overrides']> = {};
    if (options.connectionBindingsFile) {
        if (!selected?.input) throw failure('CLI_CALL_BINDINGS_INVALID', 'The selected target does not declare Flow connection bindings');
        overrides.flowConnectionBindings = await readBindings(options.connectionBindingsFile);
    }
    if (selected?.input) overrides.flowExpectedSignature = {id: selected.input.flowId as FlowId, revision: selected.input.revision, digest: selected.input.digest};

    return Object.keys(overrides).length ? overrides : undefined;
}



export async function readSubmissionFile(file: string, sessionId: string): Promise<SubmissionRequest> {
    const request = await readJson(file) as unknown as SubmissionRequest;
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('SUBMISSION_INVALID', 'A submission object is required');
    assertTargetSelection(request.target); assertFlowCallSource(request.source);
    if (request.expectedSessionId !== sessionId) throw failure('SUBMISSION_BINDING_CHANGED', 'The submission file belongs to another Session');
    const submission = request.submission;
    if (!submission || typeof submission.id !== 'string' || !/^[\w-]{1,128}$/.test(submission.id) || !submission.source
        || !['kind', 'ownerId', 'id'].every(key => typeof submission.source[key as keyof typeof submission.source] === 'string'
            && submission.source[key as keyof typeof submission.source].trim().length > 0))
        throw failure('SUBMISSION_INVALID', 'The submission file must contain an existing operation identity');
    return request;
}

export async function dispatchSessionSubmission(client: ApplicationClient, request: SubmissionRequest): Promise<string> {
    const operationId = request.submission!.id, started = Date.now();
    recordRuntimeDiagnostic('call.dispatch', {operation: 'session.submit', operationId, stage: 'admission', outcome: 'start'});
    try {
        const result = await client.services.commandBus.execute<string>(SessionCommand.Submit, request);
        if (result !== operationId) throw failure('CLI_CALL_RECEIPT_MISMATCH', 'Submission receipt has a different operation identity');
        recordRuntimeDiagnostic('call.dispatch', {operation: 'session.submit', operationId, stage: 'admission', outcome: 'accepted', durationMs: Date.now() - started});
        return result;
    } catch (error) {
        recordFailure('session.submit', operationId, 'admission', error, started);
        throw Object.assign(error instanceof Error ? error : failure('CLI_CALL_FAILED', 'Submission result is unknown'), {requestId: operationId});
    }
}

export async function inspectSessionSubmission(client: ApplicationClient, request: SubmissionRequest): Promise<SubmissionReceipt> {
    const operationId = request.submission!.id, started = Date.now();
    try {
        const receipt = await client.services.commandBus.execute<SubmissionReceipt>(SessionCommand.InspectSubmissionReceipt, request);
        if (receipt?.operationId !== operationId || !['accepted', 'unknown'].includes(receipt.status))
            throw failure('CLI_CALL_RECEIPT_MISMATCH', 'Submission receipt has a different operation identity');
        recordRuntimeDiagnostic('call.receipt', {operation: 'session.receipt', operationId, stage: 'lookup', outcome: receipt.status,
            evidence: receipt.evidence, durationMs: Date.now() - started});
        return receipt;
    } catch (error) {recordFailure('session.receipt', operationId, 'lookup', error, started); throw error;}
}

export function assertFrozenCallOptions(options: CommandOptions): void {
    if (options.agent || options.flow || options.paramsFile || options.connectionBindingsFile || options.branch || options.submissionFile)
        throw failure('CLI_CALL_OPTIONS_CONFLICT', 'A frozen submission cannot be overridden; edit input before preparing a new call');
}

async function readJson(file: string): Promise<unknown> {
    const started = Date.now(); let stage = 'file-read';
    try {
        const handle = await open(file, 'r');
        const bytes = await (async () => {
            try {
                if ((await handle.stat()).size > MAX_CALL_BYTES) throw failure('CLI_CALL_FILE_LIMIT', 'Call input exceeds 1 MiB');
                return await handle.readFile();
            } finally {await handle.close();}
        })();
        if (bytes.byteLength > MAX_CALL_BYTES) throw failure('CLI_CALL_FILE_LIMIT', 'Call input exceeds 1 MiB');
        stage = 'file-parse';
        try {return JSON.parse(bytes.toString('utf8'));}
        catch {throw failure('CLI_CALL_JSON_INVALID', 'Call input is not valid JSON; correct the file before submitting');}
    } catch (error) {
        recordFailure('session.input', undefined, stage, error, started);
        if (String((error as {code?: string})?.code).startsWith('CLI_CALL_')) throw error;
        throw failure('CLI_CALL_FILE_READ_FAILED', 'Cannot read call input file: ' + safeCode(error));
    }
}

async function readBindings(file: string): Promise<Record<string, string>> {
    const value = await readJson(file);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(binding => typeof binding !== 'string'))
        throw failure('CLI_CALL_BINDINGS_INVALID', 'Connection bindings must be a JSON object of connection IDs');
    return value as Record<string, string>;
}

async function saveSubmission(file: string, request: SubmissionRequest): Promise<void> {
    const started = Date.now(), bytes = JSON.stringify(request, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_CALL_BYTES) throw failure('CLI_CALL_FILE_LIMIT', 'Frozen submission exceeds 1 MiB');
    try {
        const handle = await open(file, 'wx', 0o600);
        try {await handle.writeFile(bytes, 'utf8'); await handle.sync(); await syncParent(file);} finally {await handle.close();}
    } catch (error) {
        recordFailure('session.prepare', request.submission!.id, 'file-write', error, started);
        throw failure('CLI_CALL_FILE_WRITE_FAILED', safeCode(error) === 'EEXIST'
            ? 'Submission file already exists; use session receipt or submit with that frozen file'
            : 'Cannot save frozen submission before dispatch: ' + safeCode(error));
    }
}

async function syncParent(file: string): Promise<void> {
    const directory = await open(dirname(resolve(file)), 'r');
    try {await directory.sync();} finally {await directory.close();}
}

function recordFailure(operation: string, operationId: string | undefined, stage: string, error: unknown, started: number): void {
    recordRuntimeDiagnostic('call.failed', {operation, operationId, stage, outcome: 'failure', code: safeCode(error), durationMs: Date.now() - started});
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CLI_CALL_FAILED';
}
function failure(code: string, message: string): Error {return Object.assign(new Error(message), {code});}
