import { expect, it, vi } from 'vitest';
import { FlowFeature } from '../src/flow-feature';
import { createChatView, createOperationLedger } from '../src';
import type { FlowOptions, FlowView } from '../src/flow';

function options(): FlowOptions {
    return { source: { getSnapshot: () => ({ flowId: 'flow', viewId: 'binding', revision: 0, graphRevision: 0,
        title: 'Flow', nodes: [], edges: [], nodeTypes: [], allowed: [], loading: false }), subscribe: () => () => {} },
        actions: {}, operations: createOperationLedger() };
}
function fakeView(): FlowView { return { setActive: vi.fn(), selectNode: vi.fn(), reconcile: vi.fn(), focus: vi.fn(), destroy: vi.fn(async () => {}) }; }
it('does not load or mount Flow until the enabled entry is opened', async () => {
    const create = vi.fn(async () => fakeView()), load = vi.fn(async () => ({ createFlowView: create }));
    const feature = new FlowFeature('Flow', options(), () => {}, load);
    expect(feature.button.hidden).toBe(true); await feature.setEnabled(true); expect(load).not.toHaveBeenCalled();
    feature.button.click(); await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await feature.setEnabled(false); expect(feature.button.hidden).toBe(true); expect(feature.pane.hidden).toBe(true);
    expect((await create.mock.results[0].value).destroy).toHaveBeenCalledOnce(); await feature.destroy();
});
it('does not mount after a disabled feature receives a late module load', async () => {
    let resolve!: (module: { createFlowView: ReturnType<typeof vi.fn> }) => void;
    const pending = new Promise<{ createFlowView: ReturnType<typeof vi.fn> }>(yes => { resolve = yes; });
    const feature = new FlowFeature('Flow', options(), () => {}, () => pending as never);
    await feature.setEnabled(true); feature.button.click(); await feature.setEnabled(false);
    const create = vi.fn(async () => fakeView()); resolve({ createFlowView: create });
    await feature.destroy(); expect(create).not.toHaveBeenCalled(); expect(feature.pane.children).toHaveLength(0);
});
it('disposes a late initialized view after the feature is disabled', async () => {
    let resolve!: (view: FlowView) => void;
    const pending = new Promise<FlowView>(yes => { resolve = yes; });
    const create = vi.fn(() => pending), feature = new FlowFeature('Flow', options(), () => {}, async () => ({ createFlowView: create }));
    await feature.setEnabled(true); feature.button.click(); await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await feature.setEnabled(false); const view = fakeView(); resolve(view); await feature.destroy();
    expect(view.destroy).toHaveBeenCalledOnce(); expect(feature.pane.children).toHaveLength(0);
});
it('exposes the switch through ChatView and rejects enabling without a binding', async () => {
    const host = document.createElement('div');
    const view = await createChatView(host, { source: { getSnapshot: () => ({ conversationId: 'c', viewId: 'v', revision: 0,
        title: '', messages: [], interactions: [], loading: false, execution: 'idle', connection: 'online', hasEarlier: false, allowed: [] }),
        subscribe: () => () => {} }, actions: {}, operations: createOperationLedger() });
    const button = [...host.querySelectorAll('button')].find(node => node.textContent === 'Flow')!;
    expect(button.hidden).toBe(true); await expect(view.setFlowEnabled(true)).rejects.toThrow('Flow options'); await view.destroy();
});
