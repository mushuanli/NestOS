import {expect, it, vi} from 'vitest';
import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {readIndependentCallInteractions} from '../src/session/independent-call-interactions';
function task(id: string, parentTaskId?: string, rootTaskId = 'root'): TaskRecord {
    return {id, parentTaskId, rootTaskId, sessionId: 'child', interactions: {ask: {id: 'ask', kind: 'input', status: 'pending',
        prompt: 'Please answer', payload: {private: 'not a display projection'}, requestedAt: 1}}} as TaskRecord;
}
function fixture(tasks: TaskRecord[]) {
    const listPendingInteractionTasks = vi.fn(async () => tasks), attachTask = vi.fn(async (id: string) => ({status: async () => ({task: task(id, id === 'root' ? undefined : 'root')})}));
    const inspectSession = vi.fn(async () => ({listPendingInteractionTasks, attachTask}));
    return {kernel: {inspectSession} as unknown as Kernel, attachTask};
}
it('projects only the selected execution descendants, including nested workers, without exposing payloads', async () => {
    const f = fixture([task('worker', 'middle'), task('unrelated', undefined, 'unrelated'), task('sibling', 'root')]);
    const root = task('middle', 'root'); root.interactions = {};
    const result = await readIndependentCallInteractions(f.kernel, root);
    expect(result).toEqual({total: 1, items: [{taskId: 'worker', interactionId: 'ask', kind: 'input', prompt: 'Please answer', promptTruncated: false, requestedAt: 1}]});
    expect(JSON.stringify(result)).not.toContain('private');
});
it('bounds request count and prompt size while preserving total pending count', async () => {
    const tasks = Array.from({length: 60}, (_, i) => task(`worker-${i}`, 'root'));
    tasks[0].interactions.ask.prompt = 'x'.repeat(2048); tasks[1].interactions.ask.status = 'resolved';
    const result = await readIndependentCallInteractions(fixture(tasks).kernel, task('root'));
    expect(result.total).toBe(59); expect(result.items).toHaveLength(50);
    expect(result.items[0]).toMatchObject({prompt: 'x'.repeat(1024), promptTruncated: true});
});
it('rejects corrupted parent cycles instead of attributing them to the call', async () => {
    const f = fixture([task('a', 'b'), task('b', 'a')]);
    await expect(readIndependentCallInteractions(f.kernel, task('root'))).rejects.toMatchObject({code: 'CALL_INTERACTION_TREE_INVALID'});
});
