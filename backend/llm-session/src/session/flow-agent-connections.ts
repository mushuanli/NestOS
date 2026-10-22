import { mergeAgentConfig } from '@itookit/llm-flow';
import type { FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import type { ExecutorConfig, TaskInput } from '../core/types';
import type { FlowIdentityResolver } from './flow-node-binder';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

/** Normalize deprecated aliases before connection admission or contextual binding. */
export function normalizeLegacyFields(config: Record<string, unknown>): Record<string, unknown> {
    const instruction = text(config.instruction) ?? text(config.prompt);
    const modelName = text(config.modelName) ?? text(config.model);
    return { ...config, ...(instruction ? { instruction } : {}), ...(modelName ? { modelName } : {}) };
}

/** One precedence rule for preflight, accepted plans and contextual node binding. */
export function agentConnectionId(config: Record<string, unknown>, defaults: Record<string, unknown>,
    agent: Pick<ExecutorConfig, 'modelDefaults'> | undefined, preferred?: string): string | undefined {
    if (config.connectionId === '') return '';
    if (text(config.connectionSlot)) return text(config.connectionId);
    return text(config.connectionId) ?? text(defaults.connectionId) ?? preferred ?? agent?.modelDefaults?.chat;
}

export function preferredTaskConnection(input: Pick<TaskInput, 'overrides' | 'instructionConnectionBinding'>): string | undefined {
    const binding = input.instructionConnectionBinding;
    return binding?.source === 'run' || binding?.source === 'session' ? binding.connectionId : input.overrides?.connectionId;
}

/** Resolve identities and connection choices without assembling conversation messages. */
export async function bindFlowAgentConnection(node: FlowNodeDefinition, defaults: FlowNodeDefinition['config'] | undefined,
    agents: FlowIdentityResolver, preferred?: string) {
    if (node.plugin !== 'builtin.agent') return {};
    const config = normalizeLegacyFields(record(node.config)), inherited = normalizeLegacyFields(record(defaults));
    const id = text(config.agentId) ?? text(inherited.agentId);
    const agent = id ? await agents.resolveExact(id).catch(error => {
        throw new Error(`Flow agent reference cannot be resolved: ${id}`, { cause: error });
    }) : undefined;
    const connectionId = agentConnectionId(config, inherited, agent, preferred);
    return { config: mergeAgentConfig(inherited, { ...config, ...(connectionId ? { connectionId } : {}) } as FlowNodeDefinition['config']) as FlowNodeDefinition['config'] };
}

/** Keep model choices in the source recipe; dispatch may rebuild only its conversational context. */
export function withAdmittedConnections(source: Record<string, unknown>, admitted: Record<string, unknown>): Record<string, unknown> {
    const result = { ...source };
    for (const key of ['connectionId', 'modelName', 'connectionRequirements', 'frozenConnection']) {
        if (Object.hasOwn(admitted, key)) result[key] = structuredClone(admitted[key]);
    }
    const saved = record(admitted.delegation);
    if (saved.resolvedTemplate || saved.resolvedTemplates) {
        const delegation = { ...record(source.delegation) };
        if (saved.resolvedTemplate) delegation.resolvedTemplate = connectionTemplate(saved.resolvedTemplate);
        if (saved.resolvedTemplates) delegation.resolvedTemplates = Object.fromEntries(Object.entries(record(saved.resolvedTemplates))
            .map(([id, value]) => [id, connectionTemplate(value)]));
        result.delegation = delegation;
    }
    return result;
}

function connectionTemplate(value: unknown): Record<string, unknown> {
    const template = record(value);
    return { plugin: template.plugin, pluginVersion: template.pluginVersion,
        config: withAdmittedConnections({}, record(template.config)) };
}
