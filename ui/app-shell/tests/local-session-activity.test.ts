// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {LocalSessionActivityView} from '../src/projects/local-session-activity';
import type {KernelViewPort} from '@itookit/durable-kernel/contracts';
import type {VFSNodeUI, VFSUIShell} from '@itookit/vfs-ui';

afterEach(() => vi.useRealTimers());

function fixture() {
    let visible = true;
    const node = (id: string): VFSNodeUI => ({id, type: 'directory', version: '1', metadata: {title: id,
        tags: [], path: id, parentPath: '/', createdAt: new Date(0).toISOString(), lastModified: new Date(0).toISOString(), custom: {keep: true}}});
    const session = node('/s'), task = node('/s/tasks/existing'), directory = {...node('/s/tasks'), children: [task]};
    const nodes = new Map([session, task, directory].map(value => [value.id, value]));
    const ui = {getNode: (id: string) => nodes.get(id), getSnapshot: () => ({expandedIds: ['/s/tasks']}),
        loadDirectory: vi.fn(async () => {}), updateNodeMetadata: vi.fn((id, metadata) => {Object.assign(nodes.get(id)!.metadata, metadata);})};
    const kernel = {sessionActivity: vi.fn(async () => ({sessionId: 's', sessionStatus: 'open', revision: 1, asOfSequence: 1,
        counts: {running: 1}, pending: {approval: 0, input: 0, cleanup: 0}})), task: vi.fn(async () => ({
        id: 'existing', program: {kind: 'test'}, status: 'succeeded', updatedAt: 42}))};
    const path = vi.fn(async () => '/s');
    const view = new LocalSessionActivityView(kernel as unknown as KernelViewPort, () => ui as unknown as VFSUIShell, () => visible, path);
    return {view, kernel, ui, path, session, hide: () => {visible = false;}, show: () => {visible = true;}};
}

it('updates loaded Session and Task rows through metadata without reloading their directory', async () => {
    const f = fixture(); f.view.invalidate('s', 'existing'); await f.view.refresh();
    expect(f.ui.updateNodeMetadata).toHaveBeenCalledWith('/s', expect.objectContaining({custom: expect.objectContaining({keep: true})}));
    expect(f.ui.updateNodeMetadata).toHaveBeenCalledWith('/s/tasks/existing', expect.objectContaining({title: 'test · succeeded · existing'}));
    expect(f.ui.loadDirectory).not.toHaveBeenCalled();
});

it('loads only an explicitly expanded Task directory when new or unidentified Tasks change', async () => {
    const f = fixture(); f.view.invalidate('s', 'new'); await f.view.refresh();
    expect(f.ui.loadDirectory).toHaveBeenCalledOnce(); expect(f.ui.loadDirectory).toHaveBeenCalledWith('/s/tasks');
    f.view.invalidate('s'); await f.view.refresh(); expect(f.ui.loadDirectory).toHaveBeenCalledTimes(2);
});

it('keeps hidden changes pending without reading activity or navigation', async () => {
    const f = fixture(); f.hide(); f.view.invalidate('s', 'existing'); await f.view.refresh();
    expect(f.path).not.toHaveBeenCalled(); expect(f.kernel.sessionActivity).not.toHaveBeenCalled();
    f.show(); await f.view.refresh(); expect(f.path).toHaveBeenCalledOnce(); expect(f.kernel.sessionActivity).toHaveBeenCalledOnce();
});

it('retains failed Session and Task projections for the next refresh', async () => {
    const f = fixture(); f.kernel.sessionActivity.mockRejectedValueOnce(new Error('temporary read failure'));
    f.view.invalidate('s', 'existing'); await f.view.refresh(); await f.view.refresh();
    expect(f.kernel.sessionActivity).toHaveBeenCalledTimes(2);
    expect(f.ui.updateNodeMetadata).toHaveBeenCalledWith('/s/tasks/existing', expect.objectContaining({title: 'test · succeeded · existing'}));
});

it('backs off failed reads and cancels retries when closed', async () => {
    vi.useFakeTimers();
    const retry = vi.fn(), read = vi.fn().mockRejectedValue(new Error('temporary'));
    const view = new LocalSessionActivityView({sessionActivity: vi.fn()} as never,
        () => ({getNode: () => undefined}) as never, () => true, read, retry);
    view.invalidate('s'); await view.refresh();
    await vi.advanceTimersByTimeAsync(999); expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(1);
    await view.refresh(); await vi.advanceTimersByTimeAsync(1999); expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(retry).toHaveBeenCalledTimes(2);
    await view.refresh(); view.close(); await vi.advanceTimersByTimeAsync(15000);
    expect(retry).toHaveBeenCalledTimes(2); await view.refresh(); expect(read).toHaveBeenCalledTimes(3);
});

it('drops refresh intents for a Session that was permanently removed', async () => {
    const f = fixture(); f.kernel.sessionActivity.mockRejectedValue(Object.assign(new Error('removed'), {code: 'ENOENT'}));
    f.view.invalidate('s'); await f.view.refresh(); await f.view.refresh();
    expect(f.kernel.sessionActivity).toHaveBeenCalledOnce(); f.view.close();
});

it('continues projecting remaining Tasks when an earlier Task was removed', async () => {
    const f = fixture();
    f.kernel.task.mockRejectedValueOnce(Object.assign(new Error('removed'), {code: 'TASK_NOT_FOUND'}));
    const task = f.ui.getNode('/s/tasks/existing')!;
    f.ui.getNode('/s/tasks')!.children!.unshift({...task, id: '/s/tasks/removed'});
    f.view.invalidate('s', 'removed'); f.view.invalidate('s', 'existing'); await f.view.refresh();
    expect(f.ui.updateNodeMetadata).toHaveBeenCalledWith('/s/tasks/existing', expect.objectContaining({title: 'test · succeeded · existing'}));
    expect(f.kernel.task).toHaveBeenCalledTimes(2); f.view.close();
});
