import {expect, it, vi} from 'vitest';
import {restoreTaskAttachment} from '../../llm-ui-adapter/src/shell/task-attachment-lifecycle';

function task(id: string, status = 'waiting', pending = true, sessionId = 'session') {
    return {id, sessionId, status, updatedAt: 1,
        interactions: pending ? {approval: {status: 'pending'}} : {}};
}

function controlFor(...tasks: ReturnType<typeof task>[]) {
    const status = vi.fn(async (id: string) => ({task: tasks.find(task => task.id === id)!}));
    const openTask = vi.fn(async (id: string) => ({status: () => status(id)}));
    return {control: {openTask} as never, openTask, status};
}

it('skips legacy RPCs and Flow reads when aggregate recovery has no waiting tasks', async () => {
    const attachment = {attach: vi.fn()}, excluded = vi.fn(), read = vi.fn(async () => ({pendingTaskIds: []}));
    await restoreTaskAttachment({} as never, 'session', attachment as never, () => true, excluded, read);
    expect(read).toHaveBeenCalledExactlyOnceWith('session', 'ui.privileged.active-task');
    expect(excluded).not.toHaveBeenCalled(); expect(attachment.attach).not.toHaveBeenCalled();
});

it('keeps the saved active task preferred and checks current Flow ownership before restoring an approval', async () => {
    const attachment = {attach: vi.fn(async () => {})}, excluded = vi.fn(async () => new Set(['flow-task']));
    const {control, openTask} = controlFor(task('active', 'running', false), task('approval'));
    await restoreTaskAttachment(control, 'session', attachment as never, () => true, excluded,
        async () => ({activeTaskId: 'active', pendingTaskIds: ['flow-task', 'approval']}));
    expect(attachment.attach).toHaveBeenLastCalledWith('active'); expect(excluded).not.toHaveBeenCalled();
    await restoreTaskAttachment(control, 'session', attachment as never, () => true, excluded,
        async () => ({pendingTaskIds: ['flow-task', 'approval']}));
    expect(attachment.attach).toHaveBeenLastCalledWith('approval'); expect(excluded).toHaveBeenCalledOnce();
    expect(openTask.mock.calls.map(([id]) => id)).toEqual(['active', 'approval']);
});

it.each(['succeeded', 'failed', 'cancelled'])('skips a %s saved task and stale pending candidates', async status => {
    const {control, openTask} = controlFor(task('active', status), task('terminal', status),
        task('resolved', 'running', false), task('foreign', 'waiting', true, 'other-session'), task('approval'));
    const attachment = {attach: vi.fn(async () => {})};
    await restoreTaskAttachment(control, 'session', attachment as never, () => true, async () => new Set(),
        async () => ({activeTaskId: 'active', pendingTaskIds: ['terminal', 'resolved', 'foreign', 'approval']}));
    expect(attachment.attach).toHaveBeenCalledExactlyOnceWith('approval');
    expect(openTask).toHaveBeenCalledTimes(5);
});

it('leaves the editor detached when every recovery candidate has become stale', async () => {
    const {control} = controlFor(task('active', 'succeeded'), task('resolved', 'running', false));
    const attachment = {attach: vi.fn()};
    await restoreTaskAttachment(control, 'session', attachment as never, () => true, async () => new Set(),
        async () => ({activeTaskId: 'active', pendingTaskIds: ['resolved']}));
    expect(attachment.attach).not.toHaveBeenCalled();
});

it.each([
    {stage: 'open', active: false}, {stage: 'status', active: false},
    {stage: 'open', active: true}, {stage: 'status', active: true},
])('discards recovery when the editor changes during task $stage (active=$active)', async ({stage, active}) => {
    let current = true;
    const attachment = {attach: vi.fn()}, status = vi.fn(async () => {
        if (stage === 'status') current = false;
        return {task: task('approval')};
    });
    const control = {openTask: async () => {if (stage === 'open') current = false; return {status};}};
    await restoreTaskAttachment(control as never, 'session', attachment as never, () => current,
        async () => new Set(), async () => ({activeTaskId: active ? 'approval' : undefined, pendingTaskIds: ['approval']}));
    expect(attachment.attach).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
});

it('reports task status failures instead of treating them as empty recovery', async () => {
    const attachment = {attach: vi.fn()};
    const control = {openTask: async () => ({status: async () => {throw new Error('storage unavailable');}})};
    await expect(restoreTaskAttachment(control as never, 'session', attachment as never, () => true,
        async () => new Set(), async () => ({activeTaskId: 'active', pendingTaskIds: ['approval']})))
        .rejects.toThrow('storage unavailable');
    expect(attachment.attach).not.toHaveBeenCalled();
});

it('discards late aggregate recovery and late Flow exclusion reads after a view changes', async () => {
    let resolve!: (value: {pendingTaskIds: string[]}) => void, current = true;
    const attachment = {attach: vi.fn()}, excluded = vi.fn(async () => new Set<string>());
    const pending = restoreTaskAttachment({} as never, 'session', attachment as never, () => current, excluded,
        () => new Promise(done => {resolve = done;}));
    current = false; resolve({pendingTaskIds: ['approval']}); await pending;
    expect(excluded).not.toHaveBeenCalled();
    current = true;
    await restoreTaskAttachment({} as never, 'session', attachment as never, () => current,
        async () => {current = false; return new Set();}, async () => ({pendingTaskIds: ['approval']}));
    expect(attachment.attach).not.toHaveBeenCalled();
});
