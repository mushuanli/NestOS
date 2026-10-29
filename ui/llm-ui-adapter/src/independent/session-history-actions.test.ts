import {expect, it, vi} from 'vitest';
import {SessionHistoryActions} from './session-history-actions';
import {SessionCommand} from '@itookit/llm-session/contracts';
it('rejects a captured history action after a revision or active binding change', async () => {
    let revision = 1, active = true;
    const execute = vi.fn(async () => ({allowed: true}));
    const history = new SessionHistoryActions({commands: {execute} as never, session: {getSessions: () => [{id: 'user', role: 'user'}]} as never,
        available: () => active, snapshot: () => ({viewId: 'view', messages: [{id: 'user', revision}]}) as never, changed: async () => {}});
    await history.actions.edit({messageId: 'user', expectedRevision: 1}, 'Changed', {operationId: 'op', viewId: 'view'});
    expect(execute).toHaveBeenCalledWith(SessionCommand.CommitEdit, {messageId: 'user', newContent: 'Changed', autoRerun: true});
    revision = 2; await expect(history.actions.retry({messageId: 'user', expectedRevision: 1}, {operationId: 'next', viewId: 'view'})).resolves.toMatchObject({status: 'rejected', code: 'HISTORY_REVISION_CONFLICT'});
    active = false; await expect(history.actions.retry({messageId: 'user', expectedRevision: 2}, {operationId: 'last', viewId: 'view'})).resolves.toMatchObject({status: 'rejected', code: 'HISTORY_REVISION_CONFLICT'});
    expect(execute).toHaveBeenCalledTimes(2);
});
