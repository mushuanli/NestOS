import type { Drawer } from '@itookit/app-contracts';
import type { FlowDraft } from '@itookit/llm-flow/contracts';

export function externalFlow(id: string): FlowDraft {
    return { id, name: id, nodes: [{ id: 'value', name: 'Value', plugin: 'builtin.transform',
        pluginVersion: '1.0.0', inputs: {}, config: { value: 'fixture' } }], edges: [], draftVersion: 1, updatedAt: 0,
        outputs: { result: { value: '${nodes.value.outputs.result}' } } } as FlowDraft;
}

export function externalFlowLibrary(): FlowDraft[] {
    return [externalFlow('shared-child'), ...['first-entry', 'second-entry'].map(id => ({ ...externalFlow(id),
        nodes: [{ id: 'invoke', name: 'Invoke', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
            config: { flowId: 'shared-child', parameters: {} } }],
        outputs: { result: { value: '${nodes.invoke.outputs.result}' } } } as FlowDraft))];
}

export function externalFlowDrawers(): Drawer[] {
    return [{ id: '/drawers/external-subflows', kind: 'flows', name: 'Reusable flows', paths: ['/flows/shared-child.flow'] }];
}

export function standaloneFlow(): FlowDraft {
    const call = (id: string, target: string, functions: FlowDraft[]): FlowDraft => ({ ...externalFlow(id), functions,
        nodes: [{ id: 'invoke', name: 'Invoke', plugin: 'builtin.flow', pluginVersion: '2.0.0', inputs: {},
            config: { flowId: target, parameters: {} } }], outputs: { result: { value: '${nodes.invoke.outputs.result}' } } } as FlowDraft);
    return call('standalone', 'helper', [call('helper', 'inner', [externalFlow('inner')])]);
}
