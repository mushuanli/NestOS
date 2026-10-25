import {expect, it, vi} from 'vitest';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {executeApplicationCommand} from '../src/application-command';

it('uses the shared query and report recovery ports with stable identities and never sends a native input', async () => {
    const result = {queryReceipts: [{id: 'query', status: 'accepted'}]}, queryCommand = vi.fn(async () => result), reconcileQuery = vi.fn(async () => result);
    const conversation = {read: vi.fn(async () => ({})), queryCommand, reconcileQuery, send: vi.fn(), reconcile: vi.fn(), close: vi.fn(async () => {})};
    const projectConversation = vi.fn(async () => conversation);
    const client = {services: {projects: {remoteMounts: {projectConversation}}}} as unknown as ApplicationClient;
    expect(await executeApplicationCommand(client, 'conversation', ['query', 'project', 'profile', 'session', '/session:status', 'query'], {})).toBe(result);
    expect(queryCommand).toHaveBeenCalledExactlyOnceWith('session:status', '', 'query');
    expect(await executeApplicationCommand(client, 'conversation', ['reconcile-query', 'project', 'profile', 'session', 'query'], {})).toBe(result);
    expect(reconcileQuery).toHaveBeenCalledExactlyOnceWith('query');
    expect(conversation.send).not.toHaveBeenCalled(); expect(conversation.reconcile).not.toHaveBeenCalled(); expect(conversation.close).toHaveBeenCalledTimes(2);
    expect(conversation.read).not.toHaveBeenCalled();
});

it('creates an explicitly selected native workspace with an epoch and unique receipt identity', async () => {
    const create = vi.fn(async () => ({session: {id: 'new-native'}})), close = vi.fn(async () => {});
    const projectHarness = vi.fn(async () => ({profiles: async () => ({epoch: 'server-epoch'}), create, close}));
    const client = {services: {projects: {remoteMounts: {projectHarness}}}} as unknown as ApplicationClient;
    await expect(executeApplicationCommand(client, 'conversation', ['create', 'project', 'profile', 'workspace'], {}))
        .resolves.toMatchObject({session: {id: 'new-native'}});
    expect(create).toHaveBeenCalledExactlyOnceWith('profile', 'workspace', {epoch: 'server-epoch', requestId: expect.any(String)});
    expect(close).toHaveBeenCalledOnce();
});

it.each(['completed', 'failed', 'await_signal'])('waits for local session %s before releasing its view', async status => {
    let global!: (event: unknown) => void, local!: (event: unknown) => void, submitted!: () => void, request: any, finished = false;
    const accepted = new Promise<void>(resolve => {submitted = resolve;});
    const dispose = vi.fn(async () => {}), offGlobal = vi.fn(), offLocal = vi.fn();
    const execute = vi.fn(async (name: string, input: any) => {
        if (name === SessionCommand.ListTargets) return {entries: [{target: {kind: 'agent', id: 'default', version: '1', digest: 'signed'}}]};
        if (name === SessionCommand.Submit) {request = input; submitted(); return input.submission.id;}
        return {sessionId: 'session', status: status === 'await_signal' ? 'running' : status};
    });
    const client = {backend: {openSessionView: async () => ({activate: async () => ({manifest: {currentBranch: 'main'}}), dispose})},
        services: {commandBus: {execute}, sessionRepository: {readDocument: async () => JSON.stringify({id: request.submission.id, sessionId: 'session',
            submission: request.submission, status: finished && status !== 'await_signal' ? status : 'running', executions: [{taskId: 'root', role: 'primary'}]})},
        kernel: {kernel: {listSessionPendingInteractionTasks: async () => finished && status === 'await_signal'
            ? [{id: 'child', rootTaskId: 'root', interactions: {input: {status: 'pending'}}}] : []}}, sessionManager: {
            onGlobalEvent: (callback: typeof global) => {global = callback; return offGlobal;},
            onEvent: (callback: typeof local) => {local = callback; return offLocal;}}}} as unknown as ApplicationClient;
    const sending = executeApplicationCommand(client, 'session', ['send', 'session', 'test prompt'], {});
    await accepted;
    expect(dispose).not.toHaveBeenCalled();
    finished = true;
    if (status === 'await_signal') local({type: 'await_signal'});
    else global({type: 'session_status_changed', payload: {sessionId: 'session', status}});
    await expect(sending).resolves.toMatchObject({accepted: request.submission.id, waitingForInput: status === 'await_signal'});
    expect(execute.mock.calls.filter(([name]) => name === SessionCommand.Submit)).toHaveLength(1);
    expect(execute.mock.calls.some(([name]) => name === SessionCommand.Send)).toBe(false);
    expect(offGlobal).toHaveBeenCalledOnce(); expect(offLocal).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
});
