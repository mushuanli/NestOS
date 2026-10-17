import {expect, it, vi} from 'vitest';
import {taskAttachment} from '../../src/host/task-attachment';
import {KernelError, KernelErrorCode} from '@itookit/durable-kernel';

function fixture() {
    const pending = (id: string, updatedAt: number, status = 'waiting', interaction = 'pending') => ({id, updatedAt, status, interactions: {answer: {status: interaction}}});
    const listPending = vi.fn(async (id: string) => [pending(`${id}-old`, 1), pending(`${id}-new`, 3), pending('finished', 4, 'succeeded'), pending('resolved', 5, 'waiting', 'resolved')]);
    const kernel = {
        openSession: vi.fn(),
        inspectSession: vi.fn(async (id: string) => ({getShared: async () => ({value: {taskId: `${id}-active`}}),
            listPendingInteractionTasks: () => listPending(id)})),
        listSessionPendingInteractionTasks: listPending,
        task: vi.fn(async (sessionId: string, id: string) => ({id, sessionId, status: 'running'})),
    };
    const getManifest = vi.fn(async () => ({})), execute = vi.fn();
    return {kernel, getManifest, execute, services: {kernel: {kernel}, sessionRepository: {getManifest}, commandBus: {execute}}};
}

it('reads detached hints for explicit Sessions without changing any browser binding', async () => {
    const f = fixture();
    const [a, b] = await Promise.all(['a', 'b'].map(id => taskAttachment(f.services as never, id, 'attachment')));
    expect(a).toEqual({activeTaskId: 'a-active', pendingTaskIds: ['a-new', 'a-old']});
    expect(b).toEqual({activeTaskId: 'b-active', pendingTaskIds: ['b-new', 'b-old']});
    expect(f.kernel.task.mock.calls).toEqual([['a', 'a-active'], ['b', 'b-active']]);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.kernel.openSession).not.toHaveBeenCalled();
    expect(JSON.stringify(a)).not.toContain('interactions');
});

it('ignores a terminal hint and rejects missing Sessions and failed reads instead of reporting empty recovery', async () => {
    const f = fixture(); f.kernel.task.mockResolvedValueOnce({id: 'a-active', sessionId: 'a', status: 'succeeded'});
    expect((await taskAttachment(f.services as never, 'a', 'attachment')).activeTaskId).toBeUndefined();
    f.getManifest.mockRejectedValueOnce(new Error('missing'));
    await expect(taskAttachment(f.services as never, 'missing', 'attachment')).rejects.toThrow('missing');
    expect(f.kernel.inspectSession).toHaveBeenCalledOnce();
    f.kernel.listSessionPendingInteractionTasks.mockRejectedValueOnce(new Error('unavailable'));
    await expect(taskAttachment(f.services as never, 'a', 'attachment')).rejects.toThrow('unavailable');
});

it('reports no attachment for a valid conversation that has never opened a Kernel Session', async () => {
    const f = fixture();
    f.kernel.inspectSession.mockRejectedValueOnce(new KernelError(KernelErrorCode.SESSION_NOT_FOUND, 'Not opened'));
    expect(await taskAttachment(f.services as never, 'new', 'attachment')).toEqual({pendingTaskIds: []});
    expect(f.kernel.listSessionPendingInteractionTasks).not.toHaveBeenCalled();
});
