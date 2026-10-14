import { DELEGATION_LIMITS, type FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import { type ChatMessage, type ContextSnapshot } from '@itookit/llm-context';
import { type LLMSkill } from '../contracts';
import type { ExecutionTask, ExecutorConfig } from '../core/types';
import { AgentResolver } from './agent-resolver';

export type FlowIdentityResolver = Pick<AgentResolver, 'resolveExact' | 'getSkills' | 'getSystemPrompt'> & Partial<Pick<AgentResolver, 'getMCPToolIds'>>;

interface BindingSetup {
    config: ExecutorConfig;
    roundId: string;
}

interface BindingContext {
    flowDefaults: Record<string, unknown>;
    snapshot: Pick<ContextSnapshot, 'blocks' | 'canonicalMessages'>;
    task: Pick<ExecutionTask, 'sessionId'> & { input: { text: string } };
    standalone?: boolean;
    setup: BindingSetup;
    agents: FlowIdentityResolver;
}

interface AgentSource {
    id: string;
    name: string;
    config: Record<string, unknown>;
    capabilities: string[];
}

interface IdentityLayer {
    referencedAgent?: ExecutorConfig;
    skills: LLMSkill[];
}

export async function bindFlowNode(
    node: FlowNodeDefinition,
    flowDefaultsValue: FlowNodeDefinition['config'] | undefined,
    snapshot: ContextSnapshot,
    task: ExecutionTask,
    setup: BindingSetup,
    agents: FlowIdentityResolver,
) {
    if (record(node.config).invocationContext === 'isolated') {
        return bindIsolatedInvocation(node, flowDefaultsValue, task.sessionId, agents);
    }
    if (node.plugin !== 'builtin.agent') {
        return { inputs: { ...node.inputs, prompt: task.input.text } };
    }
    return bindAgentSource({
        id: String(node.id),
        name: node.name,
        config: normalizeLegacyFields(record(node.config)),
        capabilities: node.capabilities ?? [],
    }, { flowDefaults: normalizeLegacyFields(record(flowDefaultsValue)), snapshot, task, setup, agents });
}

/** Resolve identities without inventing a conversation Round or inherited chat history. */
export async function bindStandaloneFlowNode(
    node: FlowNodeDefinition, defaults: FlowNodeDefinition['config'] | undefined, sessionId: string, agents: FlowIdentityResolver,
) {
    if (record(node.config).invocationContext === 'isolated') return bindIsolatedInvocation(node, defaults, sessionId, agents);
    if (node.plugin !== 'builtin.agent') return {};
    const config = normalizeLegacyFields(record(node.config));
    const flowDefaults = normalizeLegacyFields(record(defaults));
    if (!stringValue(config.instruction) && !stringValue(flowDefaults.instruction) && !Array.isArray(config.messages)) {
        config.instruction = Object.values(node.inputs).map(value => JSON.stringify(value)).join('\n');
    }
    return bindAgentSource({ id: String(node.id), name: node.name,
        config, capabilities: node.capabilities ?? [],
    }, { flowDefaults, agents, standalone: true,
        snapshot: { blocks: [], canonicalMessages: [] }, task: { sessionId, input: { text: '' } },
        setup: { config: { id: 'flow', name: 'Flow', type: 'agent' }, roundId: 'flow' },
    });
}

/** Resolve the target identity without importing the caller's conversational context. */
async function bindIsolatedInvocation(node: FlowNodeDefinition, _defaults: FlowNodeDefinition['config'] | undefined,
    sessionId: string, agents: FlowIdentityResolver) {
    if (node.plugin !== 'builtin.agent') return {};
    const config = { ...record(node.config), invocationContext: undefined, messages: undefined, historyPolicy: 'none' };
    const agentId = stringValue(record(node.config).agentId);
    if (agentId) await agents.resolveExact(agentId);
    const bound = await bindAgentSource({ id: String(node.id), name: node.name,
        config, capabilities: node.capabilities ?? [] }, { flowDefaults: {}, agents, standalone: true,
        snapshot: { blocks: [], canonicalMessages: [] }, task: { sessionId, input: { text: '' } },
        setup: { config: { id: 'flow', name: 'Flow', type: 'agent' }, roundId: 'flow' } });
    const resolved = record(bound.config);
    const messages = Array.isArray(resolved.messages) ? resolved.messages.filter(isChatMessage) : [];
    return { ...bound, config: { ...resolved, invocationInstructions: [
        ...messages.filter(message => message.role === 'system').map(message => message.content), ...taskInstruction(config)],
        messages: [], memoryPolicy: undefined } as never };
}

async function bindAgentSource(source: AgentSource, context: BindingContext, templateDepth = 0) {
    const identity = await resolveIdentity(source.config, context);
    const messages = await resolveMessages(source.config, identity, context);
    const toolIds = await resolveCapabilities(source, identity, context);
    const config = resolveExecutionConfig(source.config, identity.referencedAgent, context);
    if (templateDepth > 0) applySkillSubagentModel(config, source.config, identity);
    const delegation = await resolveDelegation(source, messages, context, templateDepth);
    return {
        config: {
            ...config,
            messages,
            sessionId: context.task.sessionId,
            roundId: `${context.setup.roundId}:${source.id}`,
            toolIds,
            ...(delegation ? { delegation } : {}),
        } as never,
        capabilities: toolIds,
    };
}

async function resolveIdentity(
    config: Record<string, unknown>,
    context: BindingContext,
): Promise<IdentityLayer> {
    const agentId = stringValue(config.agentId) ?? stringValue(context.flowDefaults.agentId);
    const referencedAgent = agentId ? await resolveAgent(agentId, context.agents) : undefined;
    const skillIds = unique([
        ...(context.setup.config.capabilityPolicy?.skillIds ?? []),
        ...strings(context.flowDefaults.skillIds),
        ...(referencedAgent?.capabilityPolicy?.skillIds ?? []),
        ...strings(config.skillIds),
    ]);
    const skills = await context.agents.getSkills(skillIds, context.task.sessionId);
    return { referencedAgent, skills: skills.filter(skill => skill.enabled && !skill.disableModelInvocation && skill.triggerStrategy !== 'action') };
}

async function resolveAgent(id: string, agents: FlowIdentityResolver): Promise<ExecutorConfig | undefined> {
    try {
        return await agents.resolveExact(id);
    } catch (error) {
        throw new Error(`Flow agent reference cannot be resolved: ${id}`, { cause: error });
    }
}

async function resolveMessages(
    config: Record<string, unknown>,
    identity: IdentityLayer,
    context: BindingContext,
): Promise<ChatMessage[]> {
    const segments = await resolvePromptSegments(config, identity, context);
    if (context.standalone) {
        const instruction = stringValue(config.instruction) ?? stringValue(context.flowDefaults.instruction) ?? '';
        const base = Array.isArray(config.messages) ? config.messages.filter(isChatMessage)
            : [{ role: 'user' as const, content: instruction }];
        return [...segments.map(content => ({ role: 'system' as const, content })),
            ...base.filter(message => systemPromptPolicy(config, context.flowDefaults) !== 'none' || message.role !== 'system')];
    }
    const base = historyPolicy(config, context.flowDefaults) === 'inherit'
        ? context.snapshot.canonicalMessages.filter(message => message.role !== 'system')
        : context.task.input.text ? [{ role: 'user' as const, content: context.task.input.text }] : [];
    return [...segments.map(content => ({ role: 'system' as const, content })), ...base];
}

async function resolvePromptSegments(
    config: Record<string, unknown>,
    identity: IdentityLayer,
    context: BindingContext,
): Promise<string[]> {
    const policy = systemPromptPolicy(config, context.flowDefaults);
    const [flowReference, nodeReference] = await Promise.all([
        resolvePromptReference(
            stringValue(context.flowDefaults.systemPromptId) === stringValue(config.systemPromptId)
                ? undefined
                : stringValue(context.flowDefaults.systemPromptId),
            context.agents,
            'Flow default',
        ),
        resolvePromptReference(stringValue(config.systemPromptId), context.agents, 'Flow node'),
    ]);
    return policy === 'none' ? [] : [
        ...(context.snapshot.blocks ?? []).flatMap(block =>
            block.kind === 'system' && ['project', 'session-skill', 'skill-index'].includes(block.source) ? [block.content] : []),
        ...(policy === 'inherit' ? context.setup.config.systemPrompt ?? [] : []),
        ...(policy === 'inherit' ? flowReference : []),
        ...(policy === 'inherit' ? strings(context.flowDefaults.systemPrompt) : []),
        ...(policy === 'inherit' ? identity.referencedAgent?.systemPrompt ?? [] : []),
        ...nodeReference,
        ...identity.skills.flatMap(skill => [
            skill.instructions,
            skill.compact?.rawContent ? `Skill ${skill.id} — critical rules:\n${skill.compact.rawContent}` : '',
        ]).filter(Boolean),
        ...strings(config.systemPrompt),
        ...(context.standalone ? [] : taskInstruction(config)),
    ];
}

async function resolvePromptReference(
    id: string | undefined,
    agents: FlowIdentityResolver,
    owner: string,
): Promise<string[]> {
    if (!id) return [];
    try {
        const prompt = await agents.getSystemPrompt(id);
        if (!prompt) throw new Error(`System prompt not found: ${id}`);
        return prompt.content;
    } catch (error) {
        throw new Error(`${owner} system prompt cannot be resolved: ${id}`, { cause: error });
    }
}

async function resolveCapabilities(
    source: AgentSource,
    identity: IdentityLayer,
    context: BindingContext,
): Promise<string[]> {
    const profiles = unique([...(context.setup.config.capabilityPolicy?.mcpProfileIds ?? []),
        ...strings(context.flowDefaults.mcpProfileIds), ...(identity.referencedAgent?.capabilityPolicy?.mcpProfileIds ?? []),
        ...strings(source.config.mcpProfileIds)]);
    if (profiles.length && !context.agents.getMCPToolIds) throw new Error('MCP profile resolution is unavailable');
    const mcpIds = profiles.length ? await context.agents.getMCPToolIds!(profiles, context.task.sessionId) : [];
    return unique([
        ...mcpIds,
        ...(context.setup.config.capabilityPolicy?.toolIds ?? []),
        ...strings(context.flowDefaults.toolIds),
        ...(identity.referencedAgent?.capabilityPolicy?.toolIds ?? []),
        ...strings(source.config.toolIds),
        ...identity.skills.flatMap(skill => skill.tools.map(tool => tool.toolId)),
        ...source.capabilities,
    ]);
}

function resolveExecutionConfig(
    config: Record<string, unknown>,
    agent: ExecutorConfig | undefined,
    context: BindingContext,
): Record<string, unknown> {
    const defaults = context.flowDefaults;
    const result = { ...defaults, ...config };
    delete result.model;
    delete result.prompt;
    // Memory authority comes only from this node's resolved Agent, never prompt/config inheritance.
    delete result.memoryPolicy;
    return {
        ...result,
        ...(agent?.memoryPolicy ? { memoryPolicy: structuredClone(agent.memoryPolicy) } : {}),
        instruction: stringValue(config.instruction),
        ...resolveModelSettings(config, agent, context),
        ...resolveHarnessSettings(config, agent, context),
    };
}

function resolveModelSettings(
    config: Record<string, unknown>,
    agent: ExecutorConfig | undefined,
    context: BindingContext,
): Record<string, unknown> {
    const defaults = context.flowDefaults;
    return {
        connectionId: stringValue(config.connectionId) ?? stringValue(defaults.connectionId),
        modelName: stringValue(config.modelName)
            ?? (stringValue(config.connectionId) ? undefined : stringValue(defaults.modelName)),
        temperature: numberValue(config.temperature) ?? agent?.temperature
            ?? numberValue(defaults.temperature) ?? context.setup.config.temperature,
        maxTokens: numberValue(config.maxTokens) ?? agent?.constraints?.maxTokens
            ?? numberValue(defaults.maxTokens) ?? context.setup.config.constraints?.maxTokens,
        timeoutMs: numberValue(config.timeoutMs) ?? agent?.constraints?.timeout
            ?? numberValue(defaults.timeoutMs) ?? context.setup.config.constraints?.timeout,
        toolTimeoutMs: config.toolTimeoutMs ?? defaults.toolTimeoutMs,
        llmRetry: config.llmRetry ?? defaults.llmRetry,
        thinking: booleanValue(config.thinking) ?? agent?.enableThinking
            ?? booleanValue(defaults.thinking) ?? context.setup.config.enableThinking,
        reasoningEffort: reasoningValue(config.reasoningEffort) ?? agent?.reasoningEffort
            ?? reasoningValue(defaults.reasoningEffort) ?? context.setup.config.reasoningEffort,
    };
}

function resolveHarnessSettings(
    config: Record<string, unknown>,
    agent: ExecutorConfig | undefined,
    context: BindingContext,
): Record<string, unknown> {
    const defaults = context.flowDefaults;
    return {
        stream: booleanValue(config.stream) ?? agent?.stream
            ?? booleanValue(defaults.stream) ?? context.setup.config.stream,
        webSearch: booleanValue(config.webSearch)
            ?? webSearchValue(agent)
            ?? booleanValue(defaults.webSearch)
            ?? webSearchValue(context.setup.config),
    };
}

async function resolveDelegation(
    parent: AgentSource,
    parentMessages: ChatMessage[],
    context: BindingContext,
    templateDepth: number,
): Promise<Record<string, unknown> | undefined> {
    const delegation = record(parent.config.delegation);
    if (delegation.enabled !== true) return undefined;
    if (templateDepth >= DELEGATION_LIMITS.maxDepth) {
        throw new Error(`Delegation template nesting exceeds ${DELEGATION_LIMITS.maxDepth}`);
    }
    const template = record(delegation.template);
    const contextSource = delegationContextSource(template.contextSource);
    const child = await bindAgentSource(childSource(parent, template, contextSource), context, templateDepth + 1);
    const resolvedConfig = record(child.config);
    ensureDelegationInstruction(resolvedConfig, template);
    applyDelegationContext(resolvedConfig, parentMessages, template, contextSource);
    return {
        ...delegation,
        resolvedTemplate: {
            plugin: 'builtin.agent',
            pluginVersion: '1.0.0',
            config: resolvedConfig,
            capabilities: child.capabilities,
        },
    };
}

function childSource(
    parent: AgentSource,
    template: Record<string, unknown>,
    contextSource: 'session' | 'parent' | 'upstream' | 'isolated',
): AgentSource {
    return {
        id: `${parent.id}:template`,
        name: `${parent.name} child`,
        config: {
            ...normalizeLegacyFields(template),
            historyPolicy: contextSource === 'session' ? 'inherit' : contextSource === 'upstream' ? 'upstream' : 'none',
        },
        capabilities: [],
    };
}

/** Keep the template's own instruction after delegation context filtering. */
function ensureDelegationInstruction(child: Record<string, unknown>, template: Record<string, unknown>): void {
    const instruction = stringValue(template.instruction) ?? stringValue(template.prompt);
    if (!instruction) return;
    const messages = Array.isArray(child.messages) ? child.messages.filter(isChatMessage) : [];
    if (messages.some(message => message.role === 'system' && message.content === instruction)) return;
    child.messages = [
        ...messages.filter(message => !(message.role === 'user' && message.content === instruction)),
        { role: 'system', content: instruction },
    ];
}

function applyDelegationContext(
    child: Record<string, unknown>,
    parentMessages: ChatMessage[],
    template: Record<string, unknown>,
    source: 'session' | 'parent' | 'upstream' | 'isolated',
): void {
    const messages = Array.isArray(child.messages) ? child.messages.filter(isChatMessage) : [];
    const childSystem = messages.filter(message => message.role === 'system');
    if (source === 'parent') {
        const parentBody = delegationParentBody(parentMessages, template.includeToolResults === true);
        child.messages = [
            ...(template.includeParentSystemPrompt !== false ? parentMessages.filter(message => message.role === 'system') : []),
            ...childSystem,
            ...parentBody,
        ];
    } else if (source === 'upstream' || source === 'isolated') {
        child.messages = childSystem;
    }
    child.includeDependencyOutputs = template.includeToolResults
        ?? (source === 'parent' || source === 'upstream');
}

function historyPolicy(config: Record<string, unknown>, defaults: Record<string, unknown>) {
    const value = config.historyPolicy ?? defaults.historyPolicy;
    return value === 'none' || value === 'upstream' ? value : 'inherit';
}

function systemPromptPolicy(config: Record<string, unknown>, defaults: Record<string, unknown>) {
    const value = config.systemPromptPolicy ?? defaults.systemPromptPolicy;
    return value === 'replace' || value === 'none' ? value : 'inherit';
}

function delegationContextSource(value: unknown): 'session' | 'parent' | 'upstream' | 'isolated' {
    return value === 'session' || value === 'parent' || value === 'upstream' || value === 'isolated'
        ? value
        : 'isolated';
}

function taskInstruction(config: Record<string, unknown>): string[] {
    const value = stringValue(config.instruction);
    return value ? [value] : [];
}

function isChatMessage(value: unknown): value is ChatMessage {
    return Boolean(value) && typeof value === 'object' && typeof (value as { role?: unknown }).role === 'string';
}

function reasoningValue(value: unknown): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
    return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' ? value : undefined;
}

function webSearchValue(config: ExecutorConfig | undefined): boolean | undefined {
    return config?.webSearchMode === undefined ? undefined : config.webSearchMode === 'builtin';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function booleanValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Normalize deprecated field aliases once at the binding boundary. */
function normalizeLegacyFields(config: Record<string, unknown>): Record<string, unknown> {
    const instruction = stringValue(config.instruction) ?? stringValue(config.prompt);
    const modelName = stringValue(config.modelName) ?? stringValue(config.model);
    return {
        ...config,
        ...(instruction ? { instruction } : {}),
        ...(modelName ? { modelName } : {}),
    };
}

function applySkillSubagentModel(config: Record<string, unknown>, source: Record<string, unknown>, identity: IdentityLayer): void {
    if (stringValue(source.modelName) || identity.referencedAgent?.model) return;
    const selected = new Set(strings(source.skillIds));
    const models = unique(identity.skills.filter(skill => selected.has(skill.id) && skill.supportsSubagent)
        .map(skill => stringValue(skill.subagentModel)).filter((model): model is string => Boolean(model)));
    if (models.length > 1) throw new Error('Selected Skills declare conflicting subagent models; set the child model explicitly');
    if (models.length === 1) config.modelName = models[0];
}

/** A child that omits tool results must not inherit calls waiting for those results. */
function delegationParentBody(messages: ChatMessage[], includeTools: boolean): ChatMessage[] {
    return messages.flatMap(message => {
        if (message.role === 'system' || (!includeTools && message.role === 'tool')) return [];
        if (includeTools || message.role !== 'assistant' || !message.tool_calls?.length) return [message];
        const { tool_calls: _calls, ...text } = message;
        return text.content ? [text as ChatMessage] : [];
    });
}
