import { getLogger, LogLevel } from '@itookit/common';
import { recordRuntimeDiagnostic } from './diagnostics';
import type { ApplicationClient } from '@itookit/app-contracts/services';
import { SessionCommand, type SessionSnapshot } from '@itookit/llm-session/contracts';
import { createAgentSendIntent } from '@itookit/llm-flow/contracts';
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
        const state = result as {snapshot?: SessionSnapshot; waitingForInput?: boolean} | undefined;
        return state?.waitingForInput ? 3 : ['failed', 'aborted'].includes(state?.snapshot?.status ?? '') ? 2 : 0;
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
    for (const entry of getLogger().query({modules: ['pi-agent'], minLevel: LogLevel.ERROR, startTime: started})) {
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

async function sessionCommand(client: ApplicationClient, args: string[], options: CommandOptions): Promise<unknown> {
    const [action, id, value] = args;
    if (action === 'list') {
        const repository = client.services.sessionRepository;
        if (!repository.listSummaries) throw new Error('Session summaries unsupported');
        return repository.listSummaries();
    }
    if (action === 'create') {
        const project = await client.services.projects.get(required(id, 'project id'));
        return (await client.backend.projectSessions()).create(required(value, 'session title'), project.path);
    }
    const opened = await client.backend.openSessionView(required(id, 'session id'));
    try {
        const initial = await opened.activate(options.branch);
        if (action === 'show') return initial.snapshot;
        const bus = client.services.commandBus;
        if (action === 'branches') return await bus.execute('vcs.branch.list');
        if (action === 'branch') return await bus.execute('vcs.branch.create', {branchNodeId: required(initial.manifest.currentHead ?? undefined, 'branch point'), options: {name: required(value, 'branch name'), copyContent: true}});
        if (action === 'delete-branch') return await bus.execute('vcs.branch.delete', {branchName: required(value, 'branch name')});
        if (action === 'send') return await sendSession(client, id!, required(value, 'message'), options);
        throw new Error('session requires list/create/show/send/branches/branch/delete-branch');
    } finally { await opened.dispose(); }
}

async function sendSession(client: ApplicationClient, id: string, text: string, options: CommandOptions): Promise<unknown> {
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const release = client.services.sessionManager.onGlobalEvent(event => {
        if (event.type === 'session_status_changed' && event.payload.sessionId === id
            && ['completed', 'failed', 'aborted'].includes(event.payload.status)) done();
    });
    let waitingForInput = false;
    const events = client.services.sessionManager.onEvent(event => {
        if (options.follow) process.stdout.write(JSON.stringify(event) + '\n');
        if (event.type === 'await_signal') { waitingForInput = true; done(); }
    });
    try {
        const agentId = options.agent ?? 'default', intent = createAgentSendIntent(agentId);
        intent.submission = {id: crypto.randomUUID(), source: {kind: 'conversation', ownerId: id, id: crypto.randomUUID()}};
        const accepted = await client.services.commandBus.execute(SessionCommand.Send, {text, agentId, sendIntent: intent});
        if (!options.connect || options.follow) await completed;
        const snapshot = await client.services.commandBus.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
        return {accepted, snapshot, waitingForInput};
    } finally { events(); release(); }
}

async function nativeConversation(client: ApplicationClient, args: string[]): Promise<unknown> {
    const [action, projectId, profileId, sessionId, value] = args;
    const remote = client.services.projects.remoteMounts;
    if (!remote) throw new Error('Remote projects unavailable');
    if (action === 'profiles' || action === 'list') {
        const harness = await remote.projectHarness(required(projectId, 'project id'));
        try { return action === 'profiles' ? await harness.profiles() : await harness.list(required(profileId, 'profile id'), {cursor: sessionId}); }
        finally { await harness.close(); }
    }
    const conversation = await remote.projectConversation(required(projectId, 'project id'), required(profileId, 'profile id'), required(sessionId, 'session id'));
    try {
        await conversation.read();
        if (action === 'show') return conversation.snapshot();
        if (action === 'branches') return await conversation.branches();
        if (action === 'send') return await conversation.send(required(value, 'message'));
        if (action === 'fork') return await conversation.fork(required(value, 'branch name'));
        if (action === 'reconcile') return await conversation.reconcile();
        if (action === 'interrupt') return await conversation.interrupt();
        throw new Error('conversation requires show/send/branches/fork/reconcile/interrupt');
    } finally { await conversation.close(); }
}
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`Missing ${name}`); return value; }
