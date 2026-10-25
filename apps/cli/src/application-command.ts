import { getLogger, LogLevel, randomUUID } from '@itookit/common';
import { recordRuntimeDiagnostic } from './diagnostics';
import type { ApplicationClient, ProjectConversationPort } from '@itookit/app-contracts/services';
import type { SessionSnapshot } from '@itookit/llm-session/contracts';
import {sessionCommand} from './application-session';
import type { CommandOptions } from './commands';
import { openCliApplication } from './application-host';

/** Commands translate terminal input/output; all authorization and mutations stay behind ports. */
export async function applicationCommand(command: string, args: string[], options: CommandOptions): Promise<number> {
    const started = Date.now();
    const log = console.log; console.log = (...values) => console.error(...values);
    let application: Awaited<ReturnType<typeof openCliApplication>> | undefined;
    try {
        application = await openCliApplication(options);
        const result = await executeApplicationCommand(application.client, command, args, options);
        process.stdout.write(JSON.stringify(result ?? {success: true}, (_key, value) => value instanceof Map ? Object.fromEntries(value) : value, 2) + '\n');
        const state = result as {snapshot?: SessionSnapshot; execution?: {status: string}; waitingForInput?: boolean} | undefined;
        return state?.waitingForInput ? 3 : ['failed', 'cancelled', 'aborted'].includes(state?.execution?.status ?? state?.snapshot?.status ?? '') ? 2 : 0;
    } catch (error) {
        const detail = error as {code?: string; remoteCode?: string; outcome?: string; requestId?: string};
        const metadata = {code: detail?.code, remoteCode: detail?.remoteCode, outcome: detail?.outcome, requestId: detail?.requestId};
        recordRuntimeDiagnostic('application.failed', metadata);
        if (Object.values(metadata).some(value => value !== undefined)) process.stderr.write(JSON.stringify(metadata) + '\n');
        throw error;
    } finally {
        try { await application?.close(); }
        finally {
            recordApplicationDiagnostics(started, command, args[0], options.connect ? 'remote' : 'local');
            console.log = log;
        }
    }
}

function recordApplicationDiagnostics(started: number, command: string, action: string | undefined, mode: string): void {
    for (const entry of getLogger().query({modules: ['mindos-node'], minLevel: LogLevel.ERROR, startTime: started})) {
        const data = entry.data as Record<string, unknown> | undefined;
        if (entry.message === 'remote.operation.failed' && data) recordRuntimeDiagnostic('remote.operation.failed',
            Object.fromEntries(['stage', 'projectId', 'profileId', 'sessionId', 'connectionId', 'code', 'causeCodes'].filter(key => data[key] !== undefined).map(key => [key, data[key]])));
    }
    recordRuntimeDiagnostic('application.complete', {command, action, mode, durationMs: Date.now() - started});
}

export async function executeApplicationCommand(client: ApplicationClient, command: string, args: string[], options: CommandOptions): Promise<unknown> {
    const [action, id, value] = args;
    if (command === 'project') {
        if (action === 'list') return client.services.projects.list();
        if (action === 'create') return client.services.projects.create(required(id, 'project name'));
    }
    if (command === 'connection' && action === 'list') return client.services.llmDriver.getConnections();
    if (command === 'mcp' && action === 'list') return (await client.services.agentService.getMCPServers()).map(server =>
        ({id: server.id, name: server.name, autoConnect: server.autoConnect}));
    if (command === 'task') {
        if (action === 'show') return client.backend.taskDetails(required(id, 'session id'), required(value, 'task id'));
        if (action === 'events') return client.backend.taskEvents(required(id, 'session id'), required(value, 'task id'));
        if (action === 'cancel') {
            await client.backend.taskDetails(required(id, 'session id'), required(value, 'task id'));
            return (await client.services.kernel.kernel.openTask(value!)).cancel();
        }
    }
    if (command === 'conversation') return nativeConversation(client, args);
    if (command === 'session') return sessionCommand(client, args, options);
    throw new Error('Unknown application command');
}

async function nativeConversation(client: ApplicationClient, args: string[]): Promise<unknown> {
    const [action, projectId, profileId, sessionId, value] = args;
    const remote = client.services.projects.remoteMounts;
    if (!remote) throw new Error('Remote projects unavailable');
    if (action === 'profiles' || action === 'list' || action === 'create') {
        const harness = await remote.projectHarness(required(projectId, 'project id'));
        try {
            if (action === 'profiles') return await harness.profiles();
            if (action === 'create') {
                const {epoch} = await harness.profiles();
                return await harness.create(required(profileId, 'profile id'), required(sessionId, 'workspace id'), {epoch, requestId: crypto.randomUUID()});
            }
            return await harness.list(required(profileId, 'profile id'), {cursor: sessionId});
        }
        finally { await harness.close(); }
    }
    const conversation = await remote.projectConversation(required(projectId, 'project id'), required(profileId, 'profile id'), required(sessionId, 'session id'));
    try {
        if (action === 'query' || action === 'reconcile-query') return await nativeQuery(conversation, action, required(value, 'query command or report id'), args[5]);
        await conversation.read();
        if (action === 'show') return conversation.snapshot();
        if (action === 'branches') return await conversation.branches();
        if (action === 'send') return await conversation.send(required(value, 'message'));
        if (action === 'fork') return await conversation.fork(required(value, 'branch name'));
        if (action === 'reconcile') return await conversation.reconcile(value);
        if (action === 'interrupt') return await conversation.interrupt();
        throw new Error('conversation requires show/send/query/reconcile-query/branches/fork/reconcile/interrupt');
    } finally { await conversation.close(); }
}
async function nativeQuery(conversation: ProjectConversationPort, action: 'query' | 'reconcile-query', value: string, requestId?: string): Promise<unknown> {
    const operationId = action === 'query' ? requestId ?? randomUUID() : value, started = Date.now();
    const correlation = /^[a-zA-Z0-9_-]{1,128}$/.test(operationId) ? operationId : randomUUID();
    try {
        if (!conversation.queryCommand || !conversation.reconcileQuery) throw Object.assign(new Error('Independent queries require a newer node'), {code: 'ECAPABILITY'});
        const result = action === 'query' ? await conversation.queryCommand(value.replace(/^\//u, ''), '', operationId)
            : await conversation.reconcileQuery(operationId);
        recordRuntimeDiagnostic('native.query.result', {operation: 'conversation.query', operationId: correlation, stage: action,
            outcome: result.queryReceipts?.some(row => row.id === operationId) ? 'accepted' : 'unknown', durationMs: Date.now() - started});
        return result;
    } catch (error) {
        const raw = (error as {remoteCode?: string; code?: string})?.remoteCode ?? (error as {code?: string})?.code;
        recordRuntimeDiagnostic('native.query.result', {operation: 'conversation.query', operationId: correlation, stage: action,
            outcome: 'failed', code: raw && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'QUERY_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`Missing ${name}`); return value; }
