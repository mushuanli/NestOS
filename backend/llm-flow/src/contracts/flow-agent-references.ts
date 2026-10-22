import type { FlowDraft, FlowRevision } from './flow-definition';

/** Rewrite declared Agent references without interpreting plugin payloads as platform identities. */
export function mapFlowAgentReferences(flow: FlowDraft | FlowRevision, resolve: (id: string) => string): void {
    mapAgentConfig(flow.defaults, resolve);
    for (const node of flow.nodes) if (node.plugin === 'builtin.agent') mapAgentConfig(node.config, resolve);
    for (const child of flow.functions ?? []) mapFlowAgentReferences(child, resolve);
}

function mapAgentConfig(value: unknown, resolve: (id: string) => string): void {
    if (!record(value)) return;
    if (typeof value.agentId === 'string') value.agentId = resolve(value.agentId);
    const delegation = value.delegation;
    if (!record(delegation)) return;
    mapAgentConfig(delegation.template, resolve);
    if (Array.isArray(delegation.agents)) for (const candidate of delegation.agents) {
        if (record(candidate) && typeof candidate.agentId === 'string') {
            candidate.agentId = resolve(candidate.agentId);
        }
    }
}

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
