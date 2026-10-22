import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { FlowCommand, mapFlowAgentReferences, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';
import { externalFlowReferences, flowRevisionToDraft, visitFlowCalls, type FlowReference } from '@itookit/llm-flow';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { createModuleLogger, randomUUID } from '@itookit/common';

export { externalFlowReferences } from '@itookit/llm-flow';
export interface ArchivePlanEntry { kind: string; id: string; data: unknown }
const log = createModuleLogger('toolbox-flow-export');

export function agentFlowReference(agent: AgentDefinition): FlowReference | undefined {
    return !agent.composition && agent.execution?.kind === 'flow' ? agent.execution : undefined;
}

export async function publishedFlowSnapshot(commands: ICommandBus, reference: FlowReference) {
    const draft = await commands.execute<FlowDraft | null>(FlowCommand.DraftLoad, { id: reference.flowId });
    if (!draft) throw new Error(`Agent Flow dependency is missing: ${reference.flowId}`);
    const revision = await commands.execute<FlowRevision | null>(FlowCommand.RevisionGet, { id: reference.flowId, revision: reference.revision });
    if (!revision) throw new Error(`Agent Flow dependency is unpublished: ${reference.flowId}@${reference.revision ?? 'latest'}`);
    if (reference.digest && reference.digest !== revision.digest) throw new Error(`Agent Flow dependency digest mismatch: ${reference.flowId}`);
    return { draft: flowRevisionToDraft(revision), references: externalFlowReferences(revision), revision: revision.revision, digest: revision.digest };
}

/** Resolve the entire published closure before any archive entry is serialized. */
export async function planAgentFlowExport(commands: ICommandBus, agents: AgentDefinition[]) {
    const operationId = randomUUID(), started = Date.now();
    try {
        const snapshots = await collectAgentFlows(commands, agents);
        log.info('Flow archive planned', { operation: 'toolbox.export', operationId, stage: 'dependency-plan',
            result: 'success', flowCount: snapshots.size, elapsedMs: Date.now() - started });
        return snapshots;
    } catch (error) {
        const message = error instanceof Error ? error.message : '';
        log.warn('Flow archive planning failed', { operation: 'toolbox.export', operationId, stage: 'dependency-plan',
            result: 'failure', errorCategory: /conflicting/.test(message) ? 'version-conflict' : /digest/.test(message)
                ? 'digest-mismatch' : /limit/.test(message) ? 'dependency-limit' : 'dependency-unavailable', elapsedMs: Date.now() - started });
        throw error;
    }
}

async function collectAgentFlows(commands: ICommandBus, agents: AgentDefinition[]) {
    const snapshots = new Map<string, Awaited<ReturnType<typeof publishedFlowSnapshot>>>();
    const visited = new Set<string>();
    const pending = agents.flatMap(agent => { const reference = agentFlowReference(agent); return reference ? [reference] : []; });
    for (const reference of pending) {
        const key = JSON.stringify([reference.flowId, reference.revision, reference.digest]);
        if (visited.has(key)) continue;
        visited.add(key);
        if (snapshots.size >= 1000) throw new Error('Archive Flow dependency limit exceeded');
        const snapshot = await publishedFlowSnapshot(commands, reference), previous = snapshots.get(reference.flowId);
        if (previous && (previous.revision !== snapshot.revision || previous.digest !== snapshot.digest))
            throw new Error(`Archive requires conflicting Flow revisions: ${reference.flowId}`);
        if (previous) continue;
        snapshots.set(reference.flowId, snapshot); pending.push(...snapshot.references);
    }
    return snapshots;
}

export function rewriteAgentFlow(agent: AgentDefinition, replacements: Map<string, string>): AgentDefinition {
    const { availability: _, ...source } = structuredClone(agent);
    if (source.composition) source.composition = { ...source.composition,
        coordinatorAgentId: replacements.get('agents/' + source.composition.coordinatorAgentId) ?? source.composition.coordinatorAgentId,
        memberAgentIds: source.composition.memberAgentIds.map(id => replacements.get('agents/' + id) ?? id) };
    if (source.modelDefaults) source.modelDefaults = Object.fromEntries(Object.entries(source.modelDefaults)
        .map(([purpose, id]) => [purpose, replacements.get('connections/' + id) ?? id]));
    if (source.execution?.kind === 'flow' && source.execution.connectionBindings) {
        source.execution.connectionBindings = Object.fromEntries(Object.entries(source.execution.connectionBindings)
            .map(([slot, id]) => [slot, replacements.get('connections/' + id) ?? id]));
    }
    const reference = agentFlowReference(source), id = reference && replacements.get('flows/' + reference.flowId);
    if (id && source.execution?.kind === 'flow') source.execution = { ...source.execution, flowId: id,
        ...(source.execution.revision !== undefined ? { revision: 1 } : {}) };
    return source;
}

export function rewriteFlowCalls(flow: FlowDraft, replacements: Map<string, string>): void {
    mapFlowAgentReferences(flow, id => replacements.get('agents/' + id) ?? id);
    visitFlowCalls(flow, ({ node, local }) => {
        const config = node.config as Record<string, unknown>;
        if (local) { delete config.revision; delete config.digest; return; }
        const target = replacements.get('flows/' + config.flowId);
        if (target) { config.flowId = target; delete config.digest; if (config.revision !== undefined) config.revision = 1; }
    });
}

/** Imported Agent bindings become runnable only after all referenced definitions publish. */
export async function publishAgentFlows(commands: ICommandBus, plan: ArchivePlanEntry[]): Promise<void> {
    const flows = new Map(plan.filter(entry => entry.kind === 'flows').map(entry => [entry.id, entry.data as FlowDraft]));
    const required = new Set<string>();
    const requireFlow = (id: string): void => {
        if (required.has(id) || !flows.has(id)) return;
        required.add(id); for (const child of externalFlowReferences(flows.get(id)!)) requireFlow(child.flowId);
    };
    for (const entry of plan.filter(entry => entry.kind === 'agents')) {
        const reference = agentFlowReference(entry.data as AgentDefinition); if (reference) requireFlow(reference.flowId);
    }
    while (required.size) {
        const ready = [...required].filter(id => externalFlowReferences(flows.get(id)!).every(child => !required.has(child.flowId)));
        if (!ready.length) throw new Error('Imported Agent Flow dependencies contain a cycle');
        for (const id of ready) {
            const draft = await commands.execute<FlowDraft>(FlowCommand.DraftLoad, { id });
            await commands.execute(FlowCommand.RevisionCreate, { draftId: id, expectedDraftVersion: draft.draftVersion }); required.delete(id);
        }
    }
}
