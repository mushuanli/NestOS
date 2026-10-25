import {FlowCommand} from '@itookit/llm-flow/contracts';
import { expect, it, vi } from 'vitest';
import {createOperationLedger, type OperationLedger, type OperationRecord} from '@itookit/llm-ui';
import {FlowInvocationCommand, SessionCommand} from '@itookit/llm-session/contracts';
import type { ICommandBus, SessionGroup, SessionViewPort } from '@itookit/llm-session/contracts';
import type {SessionInstructionQueue} from '@itookit/llm-session/contracts';
import { createSessionChatBinding } from './session';

vi.mock('@itookit/llm-ui', async () => ({...(await vi.importActual<typeof import('@itookit/llm-ui')>('@itookit/llm-ui')), createChatView: vi.fn()}));

function fixture(input?: OperationRecord['input']) {
    let committed = false, groups: SessionGroup[] = [];
    let queue: SessionInstructionQueue | undefined;
    const listeners = new Set<() => void>();
    let record: OperationRecord = { context: { operationId: 'op', viewId: 'expired' }, conversationId: 'session',
        kind: 'send', input: input ?? { text: 'hello' }, status: 'unknown' };
    const target = (input as {target?: import('@itookit/llm-flow/contracts').TargetRef})?.target;
    if (target) record = {...record, input: {...input as object, sessionRequest: {expectedSessionId: 'session', target, expectedTarget: target,
        source: {kind: 'composer', text: 'hello', attachments: [], values: {}},
        submission: {id: 'op', source: {kind: 'conversation', ownerId: 'session', id: 'op'}}}} as unknown as OperationRecord['input']};
    const operations: OperationLedger = { getSnapshot: () => [record], subscribe: () => () => {}, register: async () => {}, settle: async () => {} };
    const execute = vi.fn(async () => 'in-memory-request');
    const hasCommittedSubmission = vi.fn(async () => committed);
    const session = { id: 'session', getSnapshot: () => ({instructionQueue: queue}), getSessions: () => groups, isGenerating: () => false,
        onEvent(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; } } as unknown as SessionViewPort;
    const options = { session, commands: { execute } as unknown as ICommandBus, operations, hasCommittedSubmission };
    return { options, execute, hasCommittedSubmission, record, listeners,
        commit() { committed = true; },
        acceptQueue(ownerId = 'session') {
            queue = {sessionId: 'session', revision: 1, paused: false, items: [{id: 'op', text: 'hello', files: [], agentId: 'default',
                createdAt: 1, branch: 'main', state: 'pending', sendIntent: {execution: {kind: 'agent', agentId: 'default'},
                    branch: {mode: 'continue'}, retention: {mode: 'persistent'},
                    submission: {id: 'op', source: {kind: 'conversation', ownerId, id: 'op'}}}}]};
            listeners.forEach(listener => listener());
        },
        emit() { groups = [{ id: 'round-op-user', role: 'user', content: 'hello', timestamp: 1 } as SessionGroup]; listeners.forEach(listener => listener()); },
    };
}

it('does not acknowledge a Session request that has only entered the in-memory queue', async () => {
    const host = fixture(), binding = createSessionChatBinding(host.options);
    const receipt = await binding.actions.send!({ text: 'hello', attachments: [] }, { operationId: 'op', viewId: binding.source.getSnapshot().viewId });
    expect(host.execute).toHaveBeenCalledOnce(); expect(receipt.status).toBe('unknown');
    expect(host.hasCommittedSubmission).toHaveBeenCalledWith({ id: 'op', source: { kind: 'conversation', ownerId: 'session', id: 'op' } });
    binding.dispose();
});

it('does not acknowledge a matching queue ID when the frozen target input conflicts with its durable receipt', async () => {
    const host = fixture({text: 'Different input', attachments: [], target: {kind: 'flow', id: 'worker', version: '1', digest: 'published'}});
    host.execute.mockRejectedValue(Object.assign(new Error('Accepted input differs'), {code: 'QUEUE_CONFLICT'}));
    const onError = vi.fn(), binding = createSessionChatBinding({...host.options, onError});
    host.acceptQueue();
    await expect(binding.actions.reconcile!('op')).rejects.toMatchObject({code: 'QUEUE_CONFLICT'});
    expect(binding.source.getSnapshot().operationReceipts).toEqual([]);
    expect(host.hasCommittedSubmission).not.toHaveBeenCalled();
    binding.dispose();
});

it('reconciles the persisted original branch after reopening a different observation binding', async () => {
    const host = fixture(), operations = createOperationLedger(); let branch = 'main';
    const session = {...host.options.session, getSnapshot: () => ({view: {manifest: {currentBranch: branch}}})} as unknown as SessionViewPort;
    const options = {...host.options, session, operations};
    const original = createSessionChatBinding(options), target = {kind: 'flow', id: 'worker', version: '1', digest: 'published'};
    await original.operations.register({context: {operationId: 'reopen', viewId: original.source.getSnapshot().viewId},
        conversationId: 'session', kind: 'send', status: 'unknown', input: {text: 'Frozen input', attachments: [], target}});
    original.dispose(); branch = 'review';
    host.execute.mockResolvedValue({operationId: 'reopen', status: 'accepted'} as never);
    const reopened = createSessionChatBinding(options);
    expect(await reopened.actions.reconcile!('reopen')).toMatchObject({status: 'accepted'});
    expect(host.execute).toHaveBeenCalledWith(SessionCommand.InspectSubmissionReceipt, expect.objectContaining({
        expectedSessionId: 'session', expectedBranch: 'main', expectedTarget: target,
        source: {kind: 'composer', text: 'Frozen input', attachments: [], values: {}},
    }));
    expect(host.execute).toHaveBeenCalledOnce(); reopened.dispose();
});

it('projects durable queue acceptance without confirming an optimistic history message', async () => {
    const host = fixture({text: '', target: {kind: 'flow', id: 'worker', version: '1', digest: 'published'},
        input: {targetId: 'reader', signature: {id: 'flow', revision: 1, digest: 'published'}, values: {count: 0}}});
    host.execute.mockResolvedValue({operationId: 'op', status: 'accepted'} as never);
    const binding = createSessionChatBinding(host.options);
    host.acceptQueue('another-session');
    expect(binding.source.getSnapshot().operationReceipts).toEqual([]);
    host.acceptQueue();
    await vi.waitFor(() => expect(binding.source.getSnapshot().operationReceipts).toEqual([{status: 'accepted', operationId: 'op'}]));
    expect(binding.source.getSnapshot().messages).toEqual([]);
    expect(binding.source.getSnapshot().operationReceipts).toEqual([{status: 'accepted', operationId: 'op'}]);
    expect(await binding.actions.reconcile!('op')).toMatchObject({status: 'accepted'});
    host.emit(); await vi.waitFor(() => expect(host.hasCommittedSubmission).toHaveBeenCalled());
    expect(binding.source.getSnapshot().messages[0].acceptance).toBe('optimistic');
    expect(binding.source.getSnapshot().messages[0].parts).toContainEqual({id: 'arguments', kind: 'json', value: {count: 0}});
    host.commit(); host.emit();
    await vi.waitFor(() => expect(binding.source.getSnapshot().messages[0].acceptance).toBe('confirmed'));
    binding.dispose();
});

it('routes contributed commands and reconciliation through their owner instead of Session.Send', async () => {
    const host = fixture(), command = {id: 'view-copy', commandId: 'copy', source: {id: 'ui', label: 'UI'}, revision: 1,
        name: 'copy', description: 'Copy', kind: 'action' as const};
    const operations = {...host.options.operations, getSnapshot: () => [{...host.record, kind: 'command' as const}]};
    const execute = vi.fn(async (_input, context) => ({status: 'unknown' as const, operationId: context.operationId, message: 'pending'}));
    const reconcile = vi.fn(async operationId => ({status: 'accepted' as const, operationId}));
    const binding = createSessionChatBinding({...host.options, operations, composerCommands: {getSnapshot: () => [command], execute, reconcile}});
    const context = {operationId: 'op', viewId: binding.source.getSnapshot().viewId};
    const receipt = await binding.actions.command!({target: {id: command.id, expectedRevision: 1}, kind: 'action', text: '/copy', arguments: ''}, context);
    expect(receipt.status).toBe('unknown'); expect(host.execute).not.toHaveBeenCalled();
    expect(await binding.actions.reconcile!('op')).toMatchObject({status: 'accepted'});
    expect(reconcile).toHaveBeenCalledWith('op'); expect(host.hasCommittedSubmission).not.toHaveBeenCalled();
    binding.dispose();
});

it('confirms observed messages from backend evidence independently of the operation ledger status', async () => {
    const host = fixture(), binding = createSessionChatBinding(host.options);
    host.emit(); await vi.waitFor(() => expect(host.hasCommittedSubmission).toHaveBeenCalledOnce());
    expect(binding.source.getSnapshot().messages[0].acceptance).toBe('optimistic');
    host.commit(); host.emit();
    await vi.waitFor(() => expect(binding.source.getSnapshot().messages[0].acceptance).toBe('confirmed'));
    expect(host.record.status).toBe('unknown'); expect(binding.source.getSnapshot().messages[0].submissionId).toBe('op');
    binding.dispose();
});

it('acknowledges durable submissions and can reconcile after its view has expired', async () => {
    const host = fixture(), binding = createSessionChatBinding(host.options); host.commit();
    expect(await binding.actions.send!({ text: 'hello', attachments: [] }, { operationId: 'op', viewId: binding.source.getSnapshot().viewId }))
        .toMatchObject({ status: 'accepted', operationId: 'op' });
    binding.dispose();
    expect(await binding.actions.reconcile!('op')).toMatchObject({ status: 'accepted', operationId: 'op' });
    expect(host.listeners.size).toBe(0);
});

it('does not publish a late backend confirmation after disposal', async () => {
    const host = fixture(); let finish!: (committed: boolean) => void;
    host.hasCommittedSubmission.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const binding = createSessionChatBinding(host.options); host.emit();
    await vi.waitFor(() => expect(host.hasCommittedSubmission).toHaveBeenCalledOnce());
    const snapshot = binding.source.getSnapshot(); binding.dispose(); finish(true);
    await Promise.resolve(); await Promise.resolve();
    expect(binding.source.getSnapshot()).toBe(snapshot);
});


it('routes recovered Flow controls to Kernel receipts rather than composer commands or message admission', async () => {
    const host = fixture(), operations = createOperationLedger();
    await operations.register({context: {operationId: 'control', viewId: 'flow-control'}, conversationId: 'session', kind: 'command',
        input: {protocol: 'flow-control-v1', taskId: 'root', action: 'resume', expectedEpoch: 3}, status: 'unknown'});
    const execute = vi.fn(async () => ({requestId: 'control', action: 'run', expectedEpoch: 3, accepted: {requestId: 'control'}}));
    const reconcile = vi.fn(), binding = createSessionChatBinding({...host.options, operations, commands: {execute} as unknown as ICommandBus,
        composerCommands: {getSnapshot: () => [], execute: vi.fn(), reconcile}});
    try {
        expect(await binding.actions.reconcile!('control')).toMatchObject({status: 'accepted'});
        expect(execute).toHaveBeenCalledWith(FlowCommand.RunControlReceipt, {sessionId: 'session', taskId: 'root', requestId: 'control'});
        expect(reconcile).not.toHaveBeenCalled(); expect(host.hasCommittedSubmission).not.toHaveBeenCalled();
    } finally {binding.dispose();}
});


it('reconciles frozen child submissions through original host admission without executing a composer command', async () => {
    const host = fixture(), operations = createOperationLedger();
    const request = {sessionId: 'session', requestId: 'invocation', execution: 'child', flowId: 'f', revision: 1, parameters: {}};
    await operations.register({context: {operationId: 'invocation', viewId: 'expired'}, conversationId: 'session', kind: 'command',
        input: {protocol: 'flow-invocation-v1', request}, status: 'unknown'});
    const execute = vi.fn(async () => [{...request, rootTaskId: 'root', executionSessionId: 'child'}]);
    const reconcile = vi.fn(), binding = createSessionChatBinding({...host.options, operations, commands: {execute} as unknown as ICommandBus,
        composerCommands: {getSnapshot: () => [], execute: vi.fn(), reconcile}});
    try {
        expect(await binding.actions.reconcile!('invocation')).toMatchObject({status: 'accepted'});
        expect(execute).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledWith(FlowInvocationCommand.List, {sessionId: 'session'});
        expect(reconcile).not.toHaveBeenCalled(); expect(host.hasCommittedSubmission).not.toHaveBeenCalled();
    } finally {binding.dispose();}
});
