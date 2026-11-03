import {randomUUID, sha256HexSync} from '@itookit/common';
import type {SubmissionRequest} from '@itookit/llm-session/contracts';
import type {IFileSystem} from '@itookit/vfs-core';
import {failure, publishImmutableFile, readPrompt, type PromptJournal} from './prompt-bundle';
import type {sessionSubmission, SessionSubmissionObservation} from './session-submission';
import {readFileRequests, fileRequestDigest, responseText, type FileRequest, type FileResponse, type FileReply} from './file-exchange-protocol';
interface Turn {history?: Array<{id: string; requests: string[]}>; phase: 'idle' | 'prepared' | 'submitting'; consumed: string[]; requests?: string[]; request?: SubmissionRequest}
interface Receipt {digest: string; request: FileRequest; response?: FileResponse}
export interface FileExchangeOptions {
    finalPublished?: boolean | (() => Promise<boolean>);
    id: string; scopeId: string; directory: string; fs: IFileSystem; journal: PromptJournal & {claim(key: string): Promise<boolean>};
    submission: ReturnType<typeof sessionSubmission>;
    resolve(request: FileRequest): Promise<unknown>;
    prepare(id: string, paths: FileReply[]): Promise<SubmissionRequest>;
    report?(stage: string, id: string, code?: string): Promise<void>;
}
/** Durable files are the mailbox. A submitted continuation is only observed, never submitted twice. */
export async function advanceFileExchange(options: FileExchangeOptions, initial: SessionSubmissionObservation): Promise<SessionSubmissionObservation> {
    const key = 'file-exchange:' + options.id;
    let turn = await options.journal.get<Turn>(key) ?? {phase: 'idle', consumed: []};
    if (turn.history?.length) await options.report?.('resumed', turn.history.at(-1)!.id);
    let requests = await readFileRequests(options.fs, options.directory, options.scopeId);
    for (const request of requests) await freezeRequest(options, request);
    if (turn.phase !== 'idle') {
        const settled = await settleTurn(options, key, turn);
        if ('outcome' in settled) return settled;
        turn = settled;
        requests = await readFileRequests(options.fs, options.directory, options.scopeId);
        for (const request of requests) await freezeRequest(options, request);
    } else if (initial.outcome !== 'succeeded') return initial;
    const pending = requests.filter(request => !turn.consumed.includes(request.id));
    if (!pending.length) return {...initial, outcome: 'succeeded', code: undefined};
    if (typeof options.finalPublished === 'function' ? await options.finalPublished() : options.finalPublished) throw failure('FILE_EXCHANGE_RESULT_CONFLICT');
    if (pending.length > 16 || turn.consumed.length + pending.length > 128) throw failure('FILE_EXCHANGE_LIMIT');
    return prepareTurn(options, key, turn, pending);
}
async function settleTurn(options: FileExchangeOptions, key: string, turn: Turn): Promise<Turn | SessionSubmissionObservation> {
    for (const id of turn.requests!) {
        const receipt = await options.journal.get<Receipt>('file-exchange-request:' + options.id + ':' + id);
        if (!receipt?.response || await readPrompt(options.fs, options.directory + '/outbox/' + id + '.yaml') !== responseText(receipt.response)) throw failure('FILE_EXCHANGE_RESPONSE_CHANGED');
    }
    await options.report?.('waiting-context', turn.requests![0]);
    const result = await observeTurn(options, key, turn);
    if (result.outcome !== 'succeeded') return result;
    const completedId = turn.request!.submission!.id;
    const next = await options.journal.update<Turn>(key, old => ({phase: 'idle', consumed: [...new Set([...old!.consumed, ...old!.requests!])], history: [...old?.history ?? [], {id: completedId, requests: old!.requests!}]}));
    await options.report?.('resumed', completedId); return next;
}
async function prepareTurn(options: FileExchangeOptions, key: string, turn: Turn, pending: FileRequest[]): Promise<SessionSubmissionObservation> {
    const replies: FileReply[] = [];
    for (const request of pending) replies.push(await publishResponse(options, request));
    const request = await options.prepare(randomUUID(), replies);
    await options.journal.update<Turn>(key, old => {
        if (old && old.phase !== 'idle') throw failure('FILE_EXCHANGE_BUSY');
        return {phase: 'prepared', history: turn.history, consumed: turn.consumed, requests: pending.map(row => row.id), request};
    });
    await options.report?.('waiting-context', pending[0].id);
    const observed = await observeTurn(options, key, {phase: 'prepared', consumed: turn.consumed, requests: pending.map(row => row.id), request});
    return observed.outcome === 'succeeded' ? {...observed, outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'} : observed;
}
async function freezeRequest(options: FileExchangeOptions, request: FileRequest): Promise<void> {
    const digest = fileRequestDigest(request), saved = await options.journal.get<Receipt>('file-exchange-request:' + options.id + ':' + request.id);
    if (saved) {if (saved.digest !== digest) throw failure('FILE_EXCHANGE_REQUEST_CHANGED'); return;}
    await options.journal.update<Receipt>('file-exchange-request:' + options.id + ':' + request.id, old => {
        if (old && old.digest !== digest) throw failure('FILE_EXCHANGE_REQUEST_CHANGED');
        return old ?? {digest, request};
    });
}
async function publishResponse(options: FileExchangeOptions, request: FileRequest): Promise<FileReply> {
    const key = 'file-exchange-request:' + options.id + ':' + request.id;
    let receipt = (await options.journal.get<Receipt>(key))!;
    if (!receipt.response) {
        let result: Pick<FileResponse, 'status' | 'payload' | 'error'>;
        try {result = {status: 'ok', payload: await options.resolve(request)};}
        catch (error) {
            const value = error as {fileResponse?: boolean; code?: string};
            if (value?.fileResponse !== true) throw error;
            result = {status: 'error', error: {code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code ?? '') ? value.code! : 'FILE_EXCHANGE_RESOLUTION_FAILED'}};
        }
        const response: FileResponse = {schema: 'work-message/2', id: randomUUID(), type: 'response', scopeId: options.scopeId,
            replyTo: request.id, requestDigest: receipt.digest, ...result};
        try {responseText(response);} catch {response.status = 'error'; delete response.payload; response.error = {code: 'FILE_EXCHANGE_RESPONSE_LIMIT'};}
        receipt = await options.journal.update<Receipt>(key, old => old!.response ? old! : {...old!, response});
    }
    try {await publishImmutableFile(options.fs, options.directory + '/outbox', request.id + '.yaml', responseText(receipt.response!));}
    catch (error) {if ((error as {code?: string})?.code === 'PROMPT_SNAPSHOT_CHANGED') throw failure('FILE_EXCHANGE_RESPONSE_CHANGED'); throw error;}
    await options.report?.('response', request.id, receipt.response?.error?.code);
    return {path: options.directory + '/outbox/' + request.id + '.yaml', sha256: sha256HexSync(responseText(receipt.response!))};
}
async function observeTurn(options: FileExchangeOptions, key: string, turn: Turn): Promise<SessionSubmissionObservation> {
    try {
        if (turn.phase === 'prepared' && await options.journal.claim(key)) await options.submission.start(turn.request!);
        const result = await options.submission.inspect(turn.request!);
        return result.outcome === 'running' ? {...result, code: 'WORKSPACE_CONTEXT_PENDING'} : result;
    } catch (error) {
        const value = error as {executionOutcome?: string; retryable?: boolean; code?: string};
        if (value?.executionOutcome === 'not-started' && value.retryable === true)
            await options.journal.update<Turn>(key, old => ({...old!, phase: 'prepared'}));
        return {sessionId: turn.request!.expectedSessionId!, outcome: 'unknown', code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code ?? '') ? value.code : 'FILE_EXCHANGE_RECEIPT_UNKNOWN'};
    }
}
