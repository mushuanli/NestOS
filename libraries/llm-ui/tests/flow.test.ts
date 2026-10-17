import { afterEach, expect, it, vi } from 'vitest';
import { createFlowView, createOperationLedger, type FlowOptions, type FlowSnapshot, type FlowView } from '../src/flow';

const views: FlowView[] = [];
afterEach(async () => { for (const view of views.splice(0)) await view.destroy().catch(() => {}); document.body.replaceChildren(); });
function fixture(actions: FlowOptions['actions'] = {}) {
    let snapshot: FlowSnapshot = { flowId: 'flow', viewId: 'binding', revision: 0, graphRevision: 9,
        title: 'Flow', loading: false, allowed: ['run', 'cancel', 'updateNode', 'addNode', 'connect'], edges: [],
        nodes: [{ id: 'node', revision: 4, type: 'host-node', name: 'First', config: { prompt: 'A' },
            position: { x: 20, y: 30 }, inputs: [{ id: 'in', label: 'Input' }], outputs: [{ id: 'out', label: 'Output' }] }],
        nodeTypes: [{ id: 'host-node', label: 'Host node', fields: [{ id: 'prompt', label: 'Prompt', kind: 'text' }] }] };
    const listeners = new Set<() => void>(), operations = createOperationLedger();
    const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const host = document.createElement('div'); document.body.append(host);
    const options: FlowOptions = { source, operations, actions: { reconcile: async operationId => ({ status: 'accepted', operationId }), ...actions } };
    return { host, operations, source, listeners, options,
        async open(extra: Partial<FlowOptions> = {}) { const view = await createFlowView(host, { ...options, ...extra }); views.push(view); return view; },
        publish(update: Partial<FlowSnapshot>) { snapshot = { ...snapshot, ...update, revision: snapshot.revision + 1 }; listeners.forEach(listener => listener()); },
    };
}
function click(host: HTMLElement, action: string) { host.querySelector<HTMLButtonElement>(`[data-flow-action="${action}"]`)!.click(); }

it('uses the node revision captured when its inspector was opened', async () => {
    const updateNode = vi.fn(async (_target, _change, context) => ({ status: 'rejected' as const, operationId: context.operationId, code: 'CONFLICT', message: 'Changed in another window' }));
    const host = fixture({ updateNode }), view = await host.open(); view.selectNode('node');
    host.publish({ nodes: [{ ...host.source.getSnapshot().nodes[0], revision: 5, name: 'Other window' }] });
    const form = host.host.querySelector<HTMLFormElement>('.llm-flow__form')!;
    form.querySelector<HTMLInputElement>('[name="prompt"]')!.value = 'B'; form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(updateNode).toHaveBeenCalledOnce());
    expect(updateNode.mock.calls[0][0]).toEqual({ nodeId: 'node', expectedRevision: 4 });
    await vi.waitFor(() => expect(host.host.textContent).toContain('Changed in another window'));
});
it('keeps graph revision separate from streaming run state', async () => {
    const run = vi.fn(async (_revision, context) => ({ status: 'accepted' as const, operationId: context.operationId }));
    const host = fixture({ run }); await host.open();
    host.publish({ execution: { executionRef: 'task', state: 'running', nodes: { node: { state: 'running', output: 'delta' } } } });
    click(host.host, 'run'); await vi.waitFor(() => expect(run).toHaveBeenCalledOnce()); expect(run.mock.calls[0][0]).toBe(9);
});
it('captures the execution identity rather than cancelling whichever task is now active', async () => {
    const cancel = vi.fn(async (_ref, context) => ({ status: 'rejected' as const, operationId: context.operationId, code: 'STALE', message: 'Old task' }));
    const host = fixture({ cancel }); await host.open();
    host.publish({ execution: { executionRef: 'old', state: 'running', nodes: {} } });
    const oldButton = host.host.querySelector<HTMLButtonElement>('[data-flow-action="cancel"]')!;
    host.publish({ execution: { executionRef: 'new', state: 'running', nodes: {} } }); oldButton.click();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(cancel.mock.calls[0][0]).toBe('old');
});
it('retains unknown operations across re-opening and never automatically repeats a run', async () => {
    const run = vi.fn(async (_revision, context) => ({ status: 'unknown' as const, operationId: context.operationId, message: '?' }));
    const host = fixture({ run }), first = await host.open(); click(host.host, 'run');
    await vi.waitFor(() => expect(host.operations.getSnapshot()[0]?.status).toBe('unknown'));
    await first.destroy(); host.publish({ viewId: 'new-binding' }); const second = await host.open(); click(host.host, 'run');
    await vi.waitFor(() => expect(host.host.textContent).toContain('awaiting reconciliation'));
    expect(run).toHaveBeenCalledOnce(); await second.reconcile(host.operations.getSnapshot()[0].context.operationId);
    expect(host.operations.getSnapshot()[0].status).toBe('accepted');
});
it('connects registered ports without interpreting host node type IDs', async () => {
    const connect = vi.fn(async (_edge, context) => ({ status: 'accepted' as const, operationId: context.operationId }));
    const host = fixture({ connect }); await host.open();
    host.host.querySelector<HTMLButtonElement>('[data-port-side="outputs"]')!.click();
    host.host.querySelector<HTMLButtonElement>('[data-port-side="inputs"]')!.click();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    expect(connect.mock.calls[0][0]).toEqual({ from: { nodeId: 'node', portId: 'out' }, to: { nodeId: 'node', portId: 'in' }, expectedGraphRevision: 9 });
});
it('releases subscriptions and the toolbar even if the inspector cleanup throws', async () => {
    const host = fixture(), toolbar = vi.fn(), inspector = vi.fn(() => { throw new Error('Inspector cleanup'); });
    const view = await host.open({ mountToolbar: () => ({ destroy: toolbar }), mountInspector: () => ({ destroy: inspector }) });
    view.selectNode('node'); await expect(view.destroy()).rejects.toBeInstanceOf(AggregateError);
    expect(toolbar).toHaveBeenCalledOnce(); expect(inspector).toHaveBeenCalledOnce(); expect(host.listeners.size).toBe(0); expect(host.host.children).toHaveLength(0);
});
it('renders an inert read-only view when no mutating callbacks exist', async () => {
    const host = fixture(), view = await host.open({ actions: {} }); view.selectNode('node');
    expect(host.host.querySelector('[data-flow-action="run"]')).toBeNull();
    expect(host.host.querySelector<HTMLButtonElement>('.llm-flow__palette button')!.disabled).toBe(true);
    expect(host.host.querySelector<HTMLButtonElement>('.llm-flow__form button')!.disabled).toBe(true);
});
