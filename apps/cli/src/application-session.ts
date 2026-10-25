import {independentSessionCall} from './independent-session-call';
import {randomUUID} from '@itookit/common';
import {recordRuntimeDiagnostic} from './diagnostics';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand, assertContextBindingQuery, type ContextBindingQuery, type SubmissionRequest, type SessionSnapshot} from '@itookit/llm-session/contracts';
import type {CommandOptions} from './commands';
import {assertFrozenCallOptions, dispatchSessionSubmission, inspectSessionSubmission, prepareSessionSubmission, readSubmissionFile} from './application-submission';
import {watchSubmissionExecution} from './submission-execution';

export async function sessionCommand(client: ApplicationClient, args: string[], options: CommandOptions): Promise<unknown> {
    const [action, id, value] = args, bus = client.services.commandBus;
    if (action === 'list') {
        const repository = client.services.sessionRepository;
        if (!repository.listSummaries) throw new Error('Session summaries unsupported');
        return repository.listSummaries();
    }
    if (action === 'targets') return bus.execute(SessionCommand.ListTargets);
    if (action === 'create') {
        const project = await client.services.projects.get(required(id, 'project id'));
        return (await client.backend.projectSessions()).create(required(value, 'session title'), project.path);
    }
    const sessionId = required(id, 'session id');
    if (['call-prepare', 'call-submit', 'call-receipt'].includes(action)) return independentSessionCall(client, action, sessionId, value, options);
    if (options.callTitle !== undefined || options.transferFile !== undefined)
        throw Object.assign(new Error('Independent title and materials require session call-prepare'), {code: 'CLI_CALL_OPTIONS_CONFLICT'});
    if (action === 'contexts') return contextBindings(client, sessionId, value, options);
    if (action === 'receipt') {assertFrozenCallOptions(options); return inspectSessionSubmission(client, await readSubmissionFile(required(value, 'submission file'), sessionId));}
    if (action === 'prepare') return prepareOnly(client, sessionId, value, options);
    const frozen = action === 'submit' ? await frozenInput(value, sessionId, options) : undefined;
    return sessionViewCommand(client, action, sessionId, value, options, frozen);
}

async function sessionViewCommand(client: ApplicationClient, action: string, sessionId: string, value: string | undefined,
    options: CommandOptions, frozen?: SubmissionRequest) {
    const opened = await client.backend.openSessionView(sessionId);
    try {
        const initial = await opened.activate(options.branch);
        if (action === 'show') return initial.snapshot;
        if (action === 'send' || action === 'submit') {
            const request = frozen ?? await prepareSessionSubmission(client, sessionId, value, initial.manifest.currentBranch, options);
            return await sendPrepared(client, request, options);
        }
        return await branchCommand(client, action, value, initial.manifest.currentHead);
    } finally {await opened.dispose();}
}

async function contextBindings(client: ApplicationClient, sessionId: string, bindingId: string | undefined, options: CommandOptions) {
    const operationId = randomUUID(), started = Date.now();
    let stage = 'validate';
    try {
        const query: ContextBindingQuery = {sessionId, ...(options.branch ? {branchId: options.branch} : {}), ...(bindingId ? {bindingId} : {})};
        if (options.cursor) {
            try {query.cursor = JSON.parse(options.cursor);}
            catch {throw Object.assign(new Error('Invalid context pagination cursor JSON'), {code: 'CONTEXT_CURSOR_INVALID'});}
        }
        assertContextBindingQuery(query); stage = 'query';
        const result = await client.services.commandBus.execute(SessionCommand.ContextBindings, query);
        recordRuntimeDiagnostic('context.query', {operation: 'session.contexts', operationId, stage, outcome: 'observed', durationMs: Date.now() - started});
        return result;
    } catch (error) {
        const value = (error as {code?: unknown})?.code;
        const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'CONTEXT_QUERY_FAILED';
        recordRuntimeDiagnostic('context.query', {operation: 'session.contexts', operationId, stage, outcome: 'failure', code, durationMs: Date.now() - started});
        throw error;
    }
}

async function branchCommand(client: ApplicationClient, action: string, value: string | undefined, head: string | null) {
    const bus = client.services.commandBus;
    if (action === 'branches') return bus.execute('vcs.branch.list');
    if (action === 'branch') return bus.execute('vcs.branch.create', {branchNodeId: required(head ?? undefined, 'branch point'), options: {name: required(value, 'branch name'), copyContent: true}});
    if (action === 'delete-branch') return bus.execute('vcs.branch.delete', {branchName: required(value, 'branch name')});
    throw new Error('session requires list/targets/create/show/send/prepare/submit/receipt/call-prepare/call-submit/call-receipt/contexts/branches/branch/delete-branch');
}

async function prepareOnly(client: ApplicationClient, id: string, text: string | undefined, options: CommandOptions) {
    if (!options.submissionFile) throw new Error('session prepare requires --submission-file');
    const manifest = await client.services.sessionRepository.getManifest(id), branch = options.branch ?? manifest.currentBranch;
    if (!Object.hasOwn(manifest.branches, branch)) throw new Error('Preparation branch does not exist');
    const request = await prepareSessionSubmission(client, id, text, branch, options);
    return {operationId: request.submission!.id, target: request.expectedTarget ?? request.target, submissionFile: options.submissionFile, prepared: true};
}

async function frozenInput(file: string | undefined, id: string, options: CommandOptions) {
    assertFrozenCallOptions(options); return readSubmissionFile(required(file, 'submission file'), id);
}

async function sendPrepared(client: ApplicationClient, request: SubmissionRequest, options: CommandOptions) {
    const watching = watchSubmissionExecution(client, request, options.follow);
    try {
        const accepted = await dispatchSessionSubmission(client, request);
        const execution = !options.connect || options.follow ? await watching.wait() : undefined;
        const snapshot = await client.services.commandBus.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
        return {accepted, submission: request.submission, target: request.expectedTarget ?? request.target, execution,
            waitingForInput: execution?.waitingForInput ?? false, snapshot};
    } finally {watching.dispose();}
}

function required(value: string | undefined, name: string): string {if (!value?.trim()) throw new Error(`Missing ${name}`); return value;}
