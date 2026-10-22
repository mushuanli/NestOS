import { checkFlowSource, type FlowDefinitionStore } from '@itookit/llm-flow';
import type { AgentAvailability, AgentExecution } from '@itookit/kernel-adapters/contracts';
import type { FlowEngine } from '@itookit/llm-session';
import type { DagPluginCatalog } from '@itookit/llm-flow/contracts';

/** Flow resource existence and publication are independent from Agent persistence. */
export function createAgentFlowAvailability(engine: FlowEngine, definitions: FlowDefinitionStore, plugins?: DagPluginCatalog) {
    return {
        inspect: (execution: Extract<AgentExecution, { kind: 'flow' }>) => inspect(execution, engine, definitions, plugins),
        subscribe: (listener: () => void) => {
            const events = ['node:created', 'node:updated', 'node:deleted', 'node:renamed', 'node:moved', 'node:copied'] as const;
            const stops = events.map(event => engine.engine.on(event, listener));
            stops.push(engine.onChange(listener));
            return () => stops.forEach(stop => stop());
        },
    };
}

async function inspect(execution: Extract<AgentExecution, { kind: 'flow' }>, engine: FlowEngine,
    definitions: FlowDefinitionStore, plugins?: DagPluginCatalog): Promise<AgentAvailability> {
    const { flowId, revision } = execution;
    const disabled = (reason: AgentAvailability['reason']): AgentAvailability => ({ status: 'disabled', reason, flowId });
    if (!flowId?.trim() || revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) return disabled('flow-invalid');
    try {
        const file = await engine.findFile(`${flowId}.flow`);
        if (!file) return disabled('flow-missing');
        const draft = await definitions.loadDraft(flowId);
        if (!draft) return disabled('flow-invalid');
        const published = await definitions.loadRevision(flowId, revision);
        if (!published) return disabled(revision === undefined ? 'flow-unpublished' : 'flow-revision-missing');
        const checked = await checkFlowSource(published, { plugins, resolveComposite: (id, version) => definitions.loadRevision(id, version) });
        return checked.valid ? { status: 'ready', flowId } : disabled('flow-invalid');
    } catch { return disabled('flow-invalid'); }
}
