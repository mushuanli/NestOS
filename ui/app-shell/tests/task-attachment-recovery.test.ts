import {expect, it, vi} from 'vitest';
import {restoreTaskAttachment} from '../../llm-ui/src/shell/task-attachment-lifecycle';

it('skips legacy RPCs and Flow reads when aggregate recovery has no waiting tasks', async () => {
    const attachment = {attach: vi.fn()}, excluded = vi.fn(), read = vi.fn(async () => ({pendingTaskIds: []}));
    await restoreTaskAttachment({} as never, 'session', attachment as never, () => true, excluded, read);
    expect(read).toHaveBeenCalledExactlyOnceWith('session', 'ui.privileged.active-task');
    expect(excluded).not.toHaveBeenCalled(); expect(attachment.attach).not.toHaveBeenCalled();
});

it('keeps the saved active task preferred and checks current Flow ownership before restoring an approval', async () => {
    const attachment = {attach: vi.fn(async () => {})}, excluded = vi.fn(async () => new Set(['flow-task']));
    await restoreTaskAttachment({} as never, 'session', attachment as never, () => true, excluded,
        async () => ({activeTaskId: 'active', pendingTaskIds: ['flow-task', 'approval']}));
    expect(attachment.attach).toHaveBeenLastCalledWith('active'); expect(excluded).not.toHaveBeenCalled();
    await restoreTaskAttachment({} as never, 'session', attachment as never, () => true, excluded,
        async () => ({pendingTaskIds: ['flow-task', 'approval']}));
    expect(attachment.attach).toHaveBeenLastCalledWith('approval'); expect(excluded).toHaveBeenCalledOnce();
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
