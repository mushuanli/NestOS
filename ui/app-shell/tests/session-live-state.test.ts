// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {HistoryView} from '../../llm-ui-adapter/src/components/HistoryView';
import {LLMWorkspaceEditor} from '../../llm-ui-adapter/src/shell/LLMWorkspaceEditor';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';

vi.mock('../../llm-ui-adapter/src/components/mdx/MDxController', () => ({MDxController: class {
    constructor(private container: HTMLElement, text: string) {container.textContent = text;}
    destroy() {return Promise.resolve();} waitUntilReady() {return Promise.resolve();} activate() {}
}}));
afterEach(() => {document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

it('replaces the welcome immediately and keeps the user prompt visible before any model response', async () => {
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {} unobserve() {}});
    const host = document.createElement('div'); document.body.append(host);
    const view = new HistoryView(host, {}); view.renderWelcome();
    view.setSubmission({id: 'send-one', text: 'Prompt before model response', timestamp: 1, state: 'submitting', messageId: 'round-one-user'});
    expect(host.querySelector('.llm-ui-welcome')).toBeNull(); expect(host.textContent).toContain('Prompt before model response');
    view.processEvent({type: 'message:appended', payload: {sessionGroup: {id: 'round-one-user', role: 'user', content: 'Prompt before model response', timestamp: 1}}} as never);
    await vi.waitFor(() => expect(host.querySelector('[data-session-id="round-one-user"]')).not.toBeNull());
    expect(host.querySelector('.llm-ui-welcome')).toBeNull(); expect(host.querySelector('.llm-ui-submission-status')).toBeNull();
    expect(host.querySelectorAll('.llm-ui-session--user')).toHaveLength(1); await view.destroy();
});

it('does not turn a completed send back into loading on lease, control, or compaction events', () => {
    const indicator = {update: vi.fn()}, input = {clearInteraction: vi.fn()};
    const editor = {statusIndicator: indicator, chatInput: input, showDirectCommandOutput: vi.fn()};
    const handle = (type: string) => (LLMWorkspaceEditor.prototype as any).handleRunEvent.call(editor, {type, payload: {}});
    handle('task.started'); expect(indicator.update).toHaveBeenLastCalledWith('running');
    handle('task.succeeded'); expect(indicator.update).toHaveBeenLastCalledWith('completed');
    for (const type of ['task.leased', 'task.control.acknowledged', 'task.events.pruned', 'task.history.compacted']) handle(type);
    expect(indicator.update).toHaveBeenLastCalledWith('completed'); expect(indicator.update).toHaveBeenCalledTimes(2);
});

it('waits for remote navigation invalidation before refreshing the VFS list', async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const invalidateNavigation = vi.fn(async () => gate), refresh = vi.fn(async () => {});
    const workbench = Object.assign(Object.create(SessionWorkbench.prototype), {
        closed: false, visible: true, navigationVisible: true, navigationReady: true, sidebarLayout: {activeView: 'navigation'},
        browser: {invalidateNavigation}, sidebarUI: {refresh}, projectNavigation: {refresh: async () => {}},
        localActivity: {refresh: async () => {}},
        updateRemoteAvailability() {}, syncBranchRoute: async () => {}, waiting: [], report: vi.fn(),
    });
    const pending = (SessionWorkbench.prototype as any).refreshView.call(workbench, []);
    await vi.waitFor(() => expect(invalidateNavigation).toHaveBeenCalledOnce()); expect(refresh).not.toHaveBeenCalled();
    finish(); await pending; expect(refresh).toHaveBeenCalledOnce(); expect(workbench.report).not.toHaveBeenCalled();
});
