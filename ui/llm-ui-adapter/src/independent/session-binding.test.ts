import { expect, it, vi } from 'vitest';
import type { OperationLedger, OperationRecord } from '@itookit/llm-ui';
import type { ICommandBus, SessionGroup, SessionViewPort } from '@itookit/llm-session/contracts';
import { createSessionChatBinding } from './session';

vi.mock('@itookit/llm-ui', () => ({ createChatView: vi.fn() }));

function fixture() {
    let committed = false, groups: SessionGroup[] = [];
    const listeners = new Set<() => void>();
    const record: OperationRecord = { context: { operationId: 'op', viewId: 'expired' }, conversationId: 'session',
        kind: 'send', input: { text: 'hello' }, status: 'unknown' };
    const operations: OperationLedger = { getSnapshot: () => [record], subscribe: () => () => {}, register: async () => {}, settle: async () => {} };
    const execute = vi.fn(async () => 'in-memory-request');
    const hasCommittedSubmission = vi.fn(async () => committed);
    const session = { id: 'session', getSessions: () => groups, isGenerating: () => false,
        onEvent(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; } } as unknown as SessionViewPort;
    const options = { session, commands: { execute } as unknown as ICommandBus, operations, hasCommittedSubmission };
    return { options, execute, hasCommittedSubmission, record, listeners,
        commit() { committed = true; },
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
