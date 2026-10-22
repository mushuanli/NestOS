import { createModuleLogger, randomUUID } from '@itookit/common';
import type { AgentComposition, AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { createFlowRevision, flowRevisionToDraft, FlowDefinitionStore, type FlowStore } from '@itookit/llm-flow';
import { DELEGATION_DEFAULTS, DELEGATION_LIMITS, type FlowDraft, type FlowRevision } from '@itookit/llm-flow/contracts';

interface AgentReader { getAgentConfig(id: string): Promise<AgentDefinition | null> }
const log = createModuleLogger('agent-composition');

/** Authoring stays in the Agent; execution uses an ordinary immutable internal Flow. */
export function createAgentCompositionPreparation(store: FlowDefinitionStore, agents: AgentReader,
    receipts: Pick<FlowStore, 'findFile' | 'readFile' | 'createFile'>) {
    const owners = new Map<string, Promise<string>>();
    return async (source: AgentDefinition): Promise<AgentDefinition> => {
        if (!source.composition) return source;
        const operationId = randomUUID(), started = Date.now();
        let stage = 'validation';
        try {
            const composition = validateComposition(source.composition);
            stage = 'references';
            const candidates = await compositionAgents(source.id, composition, agents);
            stage = 'ownership';
            if (!owners.has(source.id)) owners.set(source.id, compositionFlowId(source.id, store, receipts)
                .catch(error => { owners.delete(source.id); throw error; }));
            const id = await owners.get(source.id)!;
            stage = 'publication';
            const draft = compileAgentComposition({ ...source, composition }, id, candidates);
            const revision = await publishComposition(store, draft);
            log.info('Agent composition prepared', { operation: 'agent.composition', operationId, stage: 'publish', result: 'success',
                agentId: source.id, flowId: id, revision: revision.revision, memberCount: composition.memberAgentIds.length, elapsedMs: Date.now() - started });
            return { ...source, type: 'composite', composition, execution: { kind: 'flow', flowId: id, revision: revision.revision } };
        } catch (error) {
            const code = `AGENT_COMPOSITION_${stage.toUpperCase()}_FAILED`;
            log.warn('Agent composition preparation failed', { operation: 'agent.composition', operationId, stage, result: 'failure',
                agentId: source.id, code, errorType: error instanceof Error ? error.name : 'unknown', elapsedMs: Date.now() - started });
            throw Object.assign(error instanceof Error ? error : new Error('Agent composition preparation failed'), { code });
        }
    };
}

export function validateComposition(value: AgentComposition): AgentComposition {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.coordinatorAgentId !== 'string'
        || !value.coordinatorAgentId.trim() || !Array.isArray(value.memberAgentIds) || !value.memberAgentIds.length
        || value.memberAgentIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('A composition requires a coordinator and at least one member Agent');
    if (value.memberAgentIds.includes(value.coordinatorAgentId)) throw new Error('The coordinator must be separate from the member Agents');
    for (const [name, limit] of [['maxDelegations', DELEGATION_LIMITS.maxTasks], ['maxConcurrency', DELEGATION_LIMITS.maxConcurrency]] as const) {
        if (value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name]! < 1 || value[name]! > limit)) throw new Error(`Composition ${name} must be an integer between 1 and ${limit}`);
    }
    return { ...value, memberAgentIds: [...new Set(value.memberAgentIds)] };
}

async function compositionAgents(id: string, composition: AgentComposition, agents: AgentReader): Promise<AgentDefinition[]> {
    const ids = [composition.coordinatorAgentId, ...composition.memberAgentIds];
    return Promise.all(ids.map(async agentId => {
        if (agentId === id) throw new Error('A composition cannot reference itself');
        const agent = await agents.getAgentConfig(agentId);
        if (!agent) throw new Error(`Composition Agent is unavailable: ${agentId}`);
        if (agent.composition || agent.execution?.kind === 'flow') throw new Error(`Composition members must be ordinary Agents: ${agentId}`);
        return agent;
    }));
}

export function compileAgentComposition(agent: AgentDefinition, flowId: string, candidates: AgentDefinition[]): FlowDraft {
    const composition = validateComposition(agent.composition!);
    const maxTasks = composition.maxDelegations ?? DELEGATION_DEFAULTS.maxTasks;
    const maxConcurrency = Math.min(composition.maxConcurrency ?? DELEGATION_DEFAULTS.maxConcurrency, maxTasks);
    const common = { agentId: composition.coordinatorAgentId, historyPolicy: 'none', systemPromptPolicy: 'inherit', includeDependencyOutputs: true };
    return { id: flowId as FlowDraft['id'], name: agent.name, draftVersion: 1, updatedAt: Date.now(), parameters: [], connections: [], layout: {},
        nodes: [
            { id: 'coordinator', name: 'Coordinator', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: { prompt: '${input.prompt}' },
                config: { ...common, instruction: 'Analyze the request. Select relevant member Agents from the delegation tool and assign one bounded batch of tasks. If no member is needed, answer directly.',
                    persistOutput: false, delegation: { enabled: true,
                        agents: candidates.filter(candidate => composition.memberAgentIds.includes(candidate.id)).map(candidate => ({ agentId: candidate.id, name: candidate.name,
                            ...(candidate.description ? { description: candidate.description } : {}) })),
                        template: { contextSource: 'isolated', includeParentSystemPrompt: false },
                        fanout: { maxTasks, maxConcurrency, maxDepth: 1 },
                        result: { mode: 'collect', order: 'declared', targetNodeId: 'summary' }, failure: { policy: 'fail-fast' } } } },
            { id: 'summary', name: 'Coordinator summary', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: { prompt: '${input.prompt}' },
                config: { ...common, instruction: 'Answer the original request using the delegated member results. Produce the final answer yourself.', delegation: { enabled: false } } },
        ], edges: [{ id: 'coordinator-summary' as FlowDraft['edges'][number]['id'], from: 'coordinator', to: 'summary', output: 'result', input: 'input', kind: 'data' }],
        outputs: { result: { value: '${nodes.summary.outputs.result}' } }, runPolicy: { maxNodes: maxTasks + 3, maxConcurrency },
    } as FlowDraft;
}

async function compositionFlowId(agentId: string, store: FlowDefinitionStore,
    receipts: Pick<FlowStore, 'findFile' | 'readFile' | 'createFile'>): Promise<string> {
    const name = `.agent-composition-${encodeURIComponent(agentId)}.json`;
    const existing = await receipts.findFile(name);
    if (existing) {
        const receipt = JSON.parse(await receipts.readFile(existing.nodeId) ?? 'null');
        if (!receipt || receipt.version !== 1 || receipt.agentId !== agentId || typeof receipt.flowId !== 'string' || !receipt.flowId.trim()) {
            throw new Error('Managed composition ownership receipt is invalid');
        }
        return receipt.flowId;
    }
    const flowId = randomUUID();
    if (await store.loadDraft(flowId)) throw new Error('Managed composition Flow identity conflicts with an existing definition');
    await receipts.createFile(name, JSON.stringify({ version: 1, agentId, flowId }));
    return flowId;
}

async function publishComposition(store: FlowDefinitionStore, desired: FlowDraft) {
    const existing = await store.loadDraft(desired.id) ?? await store.createDraft({ id: desired.id, name: desired.name });
    const body = (flow: FlowDraft | FlowRevision) => createFlowRevision('revision' in flow ? flowRevisionToDraft(flow) : flow, 1, 0).digest;
    const latest = await store.loadRevision(desired.id);
    if (latest && body(latest) === body(desired)) return latest;
    const draft = body(existing) === body(desired) ? existing
        : await store.saveDraft({ ...desired, draftVersion: existing.draftVersion }, existing.draftVersion);
    return store.createRevision(draft);
}
