import type {FlowDraft, FlowRevision, JsonValue} from '@itookit/llm-flow/contracts';

/** Project runtime binding changes Agent execution, never the published source definition. */
export function promptHarnessFlow<T extends FlowDraft | FlowRevision>(flow: T, connectionId: string): T {
    const nodes = flow.nodes.map(node => {
        if (node.plugin !== 'builtin.agent') return node;
        const config: Record<string, JsonValue> = {...(node.config && typeof node.config === 'object' && !Array.isArray(node.config) ? node.config : {})};
        for (const key of ['connectionId', 'connectionSlot', 'modelName', 'frozenConnection', 'connectionRequirements']) delete config[key];
        return {...node, capabilities: [], config: {...config, execution: {kind: 'harness' as const, connectionId}}};
    });
    const used = new Set(nodes.filter(node => node.plugin !== 'builtin.agent').flatMap(node => {
        const config = node.config as Record<string, unknown> | undefined;
        return [config?.connectionSlot, config?.connectionId];
    }));
    const connections = flow.connections?.filter(slot => used.has(slot.name));
    return {...flow, nodes, connections,
        defaultConnection: connections?.some(slot => slot.name === flow.defaultConnection) ? flow.defaultConnection : undefined};
}
