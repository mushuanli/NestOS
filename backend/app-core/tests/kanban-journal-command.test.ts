import {expect, it, vi} from 'vitest';
import {KanbanError} from '@itookit/kanban';
import type {KanbanService} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {journalCommand} from '../src/kanban/journal-command';

it('rebases only a definite rejection and preserves the exact request after an unknown response', async () => {
    const rows = new Map<string, unknown>();
    const journal = {get: async (key: string) => rows.get(key), update: async (key: string, change: (old: unknown) => unknown) => {
        const next = change(rows.get(key)); rows.set(key, next); return next;
    }} as KanbanAutomationJournal;
    let revision = 1;
    const execute = vi.fn().mockImplementationOnce(async () => {revision = 2; throw new KanbanError('REVISION_CONFLICT');})
        .mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue(undefined);
    const service = {read: async () => ({revision}), execute} as unknown as KanbanService;
    const run = () => journalCommand(journal, service, 'board', 'key', {type: 'message', itemId: 'item', message: 'Progress', recipientSessionIds: []});
    await expect(run()).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    await expect(run()).rejects.toThrow('Response lost');
    await run(); await run();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1][1]).toMatchObject({expectedRevision: 2});
    expect(execute.mock.calls[1][1].operationId).not.toBe(execute.mock.calls[0][1].operationId);
    expect(execute.mock.calls[2][1]).toEqual(execute.mock.calls[1][1]);
});
