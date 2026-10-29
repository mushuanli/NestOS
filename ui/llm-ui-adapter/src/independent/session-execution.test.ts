import {expect, it, vi} from 'vitest';
import {SessionExecution} from './session-execution';
it('keeps the whole Flow waiting while a completed step has a pending structured successor', async () => {
    const request = {id: 'review', kind: 'input', status: 'pending', prompt: 'Review', requestedAt: 1,
        payload: {fields: {cards: {type: 'json'}}, values: {cards: []}}};
    const tasks = [{id: 'root', sessionId: 's', rootTaskId: 'root', status: 'waiting', interactions: {}},
        {id: 'step', sessionId: 's', rootTaskId: 'root', status: 'succeeded', interactions: {}},
        {id: 'input', sessionId: 's', rootTaskId: 'root', status: 'waiting', interactions: {review: request}}];
    const kernel = {listSessionTasks: vi.fn(async () => tasks)};
    const execution = new SessionExecution(kernel as never, 's', () => [{execution: {taskId: 'root'}}] as never,
        () => true, vi.fn(), vi.fn(), true);
    try {
        await execution.refresh(); expect(execution.waiting).toBe(true); expect(execution.running).toBe(true);
        expect(execution.interactions).toEqual([]);
        request.status = 'resolved'; tasks[2].status = 'succeeded';
        await execution.refresh(); expect(execution.waiting).toBe(false); expect(execution.running).toBe(true);
        tasks[0].status = 'succeeded'; await execution.refresh(); expect(execution.running).toBe(false);
    } finally {execution.dispose();}
});
