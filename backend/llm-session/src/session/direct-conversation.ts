import type { ChatMessage, ContextSnapshot, ToolDefinition } from '@itookit/llm-context';
import type { TaskSpec } from '@itookit/durable-kernel';
import type { LLMSkill } from '../contracts';
import type { ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { buildLlmTaskInput, buildSkillContexts, type DurableAgentInput, type SkillContext } from '@itookit/llm-tasks';
import { CLIENT_WEB_SEARCH_TOOL, directExecutionMode, directToolIds } from './direct-execution-mode';
import {sha256HexSync} from '@itookit/llm-context';
import {harnessInputDigest, prepareHarnessInput, type HarnessContextRequest} from '@itookit/kernel-adapters/contracts';
import type {HarnessProgramInput} from '@itookit/kernel-adapters';
import {directHarnessContextIdentity} from '../contracts/context-options';

import type {ChatAttachment, ExecutionTask, ExecutorConfig} from '../core/types';

export interface DirectToolCatalog {definitions: ToolDefinition[]; externalIds: string[];}
/** Ready context and input only; planning does not require a UI state or a running Task. */
export interface DirectConversationInput {
    task: Pick<ExecutionTask, 'sessionId' | 'input'>;
    config: ExecutorConfig;
    roundId: string;
    contextFiles?: ChatAttachment[];
    currentInput?: ChatMessage;
}

export interface DirectConversationPorts {
    resolveHarnessToolIds?(sessionId: string): Promise<string[]>;
    resolveMCPToolIds?(sessionId: string, ids: string[]): Promise<string[]>;
    resolveSkills?(ids: string[], sessionId?: string): Promise<LLMSkill[]>;
    resolveTools?(sessionId: string, allowedIds: string[]): Promise<DirectToolCatalog>;
}

export async function prepareDirectConversation<T extends DirectConversationInput>(options: DirectConversationPorts, execution: T) {
    if (execution.config.execution?.kind === 'harness') return { execution, skills: [], skillsPrompt: '' };
    execution = await prepareDefaultTools(options, execution);
    execution = await prepareMcpTools(options, execution);
    const ids = execution.config.capabilityPolicy?.skillIds ?? [];
    const skills = structuredClone(ids.length ? await options.resolveSkills?.(ids, execution.task.sessionId) ?? [] : []);
    return {execution, skills, skillsPrompt: directSkillsPrompt(ids, skills)};
}

async function prepareDefaultTools<T extends DirectConversationInput>(options: DirectConversationPorts, execution: T) {
    if (directExecutionMode(execution.task.input) !== 'agent' || execution.config.capabilityPolicy?.toolIds !== undefined) return execution;
    const toolIds = [...await options.resolveHarnessToolIds?.(execution.task.sessionId) ?? []];
    return {...execution, config: {...execution.config, capabilityPolicy: {mcpProfileIds: [], ...execution.config.capabilityPolicy, toolIds}}};
}

async function prepareMcpTools<T extends DirectConversationInput>(options: DirectConversationPorts, execution: T) {
    const profiles = execution.config.capabilityPolicy?.mcpProfileIds ?? [];
    if (!profiles.length || directExecutionMode(execution.task.input) === 'chat') return execution;
    if (!options.resolveMCPToolIds) throw new Error('MCP profile resolution is unavailable');
    const mcpIds = await options.resolveMCPToolIds(execution.task.sessionId, profiles), policy = execution.config.capabilityPolicy!;
    return {...execution, config: {...execution.config,
        capabilityPolicy: {...policy, toolIds: [...new Set([...(policy.toolIds ?? []), ...mcpIds])]}}};
}

function directSkillsPrompt(ids: string[], skills: LLMSkill[]): string {
    return skills.filter(skill => ids.includes(skill.id) && skill.enabled && !skill.disableModelInvocation && skill.triggerStrategy !== 'action')
        .flatMap(skill => [skill.instructions, skill.compact?.rawContent ? `Skill ${skill.id} — critical rules:\n${skill.compact.rawContent}` : ''])
        .filter(Boolean).join('\n\n');
}

export function directTaskSpec(
    execution: DirectConversationInput,
    snapshot: ContextSnapshot,
    catalog: DirectToolCatalog,
    skills: LLMSkill[],
    policy: ResolvedDirectAgentPolicy,
): TaskSpec<DurableAgentInput | HarnessProgramInput> {
    return execution.config.execution?.kind === 'harness' ? nativeTaskSpec(execution, snapshot)
        : modelTaskSpec(execution, snapshot, catalog, skills, policy);
}

function nativeTaskSpec(execution: DirectConversationInput, snapshot: ContextSnapshot): TaskSpec<HarnessProgramInput> {
    if (!execution.config.harnessConnection) throw new Error('Harness connection snapshot is required');
    if (execution.task.input.files.length && !execution.currentInput?.attachments?.length) throw new Error('HARNESS_CURRENT_INPUT_REQUIRED');
    const input = harnessInput(execution, snapshot); prepareHarnessInput(input);
    return {program: {kind: 'kernel-adapters.harness', version: '1'}, input,
        labels: {roundId: execution.roundId, kind: 'agent'}, deferStart: true};
}

function modelTaskSpec(execution: DirectConversationInput, snapshot: ContextSnapshot,
    catalog: DirectToolCatalog, skills: LLMSkill[], policy: ResolvedDirectAgentPolicy): TaskSpec<DurableAgentInput> {
    const tools = directToolIds(execution.config, execution.task.input);
    const mode = directExecutionMode(execution.task.input);
    const { definitions, allowedToolIds, skillContexts } = directBindings(execution, catalog, skills, tools);
    return {
        program: { kind: mode === 'agent' || tools.length ? 'llm.agent' : 'llm.chat', version: '1' },
        input: buildLlmTaskInput({
            ...directInput(execution, snapshot, policy),
            tools: definitions,
            allowedToolIds,
            externalToolIds: catalog.externalIds,
            memoryPolicy: execution.config.memoryPolicy,
            ...(skillContexts.length ? { skillContexts } : {}),
        }),
        labels: { roundId: execution.roundId, kind: mode === 'agent' || tools.length ? 'agent' : 'chat',
            ...(mode ? { executionMode: mode } : {}) },
        deferStart: true,
    };
}

function harnessInput(execution: DirectConversationInput, snapshot: ContextSnapshot): HarnessProgramInput {
    const {canonicalMessages, ...contextSnapshot} = structuredClone(snapshot), context = harnessContext(execution, snapshot);
    if (context && context.conversation.mode !== 'new') return {connection: structuredClone(execution.config.harnessConnection!),
        ...harnessIncrementalInput(execution), context};
    return {connection: structuredClone(execution.config.harnessConnection!), messages: canonicalMessages,
        ...(context ? {context, contextSnapshot} : {})};
}

function harnessContext(execution: DirectConversationInput, snapshot: ContextSnapshot): HarnessContextRequest | undefined {
    const invocation = execution.task.input.invocation;
    if (!invocation) {
        if (execution.task.input.overrides?.harnessConversation) throw new Error('CONTEXT_INVOCATION_REQUIRED');
        return;
    }
    const connection = execution.config.harnessConnection!;
    const conversation = structuredClone(execution.task.input.overrides?.harnessConversation ?? {mode: 'new' as const});
    return {invocationId: invocation.invocationId, branchId: snapshot.branchRef,
        ...directHarnessContextIdentity(snapshot.agent, connection.project), scopeRef: `conversation:${execution.config.id}`,
        policyRef: sha256HexSync(JSON.stringify(snapshot.blocks.filter(block => block.kind === 'system'))),
        conversation, input: conversation.mode === 'new' ? {mode: 'host-assembled', snapshotRef: snapshot.id, digest: snapshot.digest}
            : {mode: 'native-continuation', inputRef: `invocation:${invocation.invocationId}:input`, digest: incrementalDigest(execution)}};
}

function harnessIncrementalInput(execution: DirectConversationInput) {
    if (!execution.currentInput && execution.contextFiles?.length) throw new Error('HARNESS_CURRENT_INPUT_REQUIRED');
    return prepareHarnessInput({messages: [execution.currentInput ?? {role: 'user', content: execution.task.input.text}]});
}
function incrementalDigest(execution: DirectConversationInput): string {
    const input = harnessIncrementalInput(execution);
    return harnessInputDigest(input);
}

/**
 * Host-side Skill activation port for Flow Agent nodes: resolves the selected Skills and
 * binds their tools against the same catalog the node itself is allowed to use.
 */
export function skillContextResolver(options: Pick<DirectConversationPorts, 'resolveSkills' | 'resolveTools'>) {
    return async (sessionId: string, skillIds: string[], allowedToolIds: string[]): Promise<SkillContext[]> => {
        if (!options.resolveSkills) return [];
        const skills = await options.resolveSkills(skillIds, sessionId);
        if (!skills.length) return [];
        const catalog = await options.resolveTools?.(sessionId, allowedToolIds) ?? { definitions: [], externalIds: [] };
        return buildSkillContexts(skills, catalog, allowedToolIds, new Set(skillIds));
    };
}

/** Resolve the name from either supported tool shape. */
function toolNameOf(tool: ToolDefinition): string {
    return tool.function?.name ?? tool.name ?? '';
}

function directBindings(execution: DirectConversationInput, catalog: DirectToolCatalog, skills: LLMSkill[], tools: string[]) {
    // The host search decision selects one search mechanism.
    const definitions = catalog.definitions.filter(tool => tools.includes(toolNameOf(tool))
        && (execution.config.webSearchMode === 'client-tool' || toolNameOf(tool) !== CLIENT_WEB_SEARCH_TOOL));
    // Initial Skill selection activates the same snapshots a runtime load_skill returns,
    // so critical rules are re-injected per round and tools stay inside the declared set.
    const allowedToolIds = execution.config.webSearchMode === 'client-tool'
        ? tools : tools.filter(id => id !== CLIENT_WEB_SEARCH_TOOL);
    const skillContexts = buildSkillContexts(skills, { definitions: catalog.definitions, externalIds: catalog.externalIds },
        allowedToolIds, new Set(execution.config.capabilityPolicy?.skillIds ?? []));
    return { definitions, allowedToolIds, skillContexts };
}
function directInput(execution: DirectConversationInput, snapshot: ContextSnapshot, policy: ResolvedDirectAgentPolicy) {
    const mode = directExecutionMode(execution.task.input);
    return {
        sessionId: execution.task.sessionId,
        roundId: execution.roundId,
        messages: snapshot.canonicalMessages,
        connectionId: execution.config.connectionId,
        model: execution.config.model,
        temperature: execution.config.temperature,
        maxTokens: execution.config.constraints?.maxTokens,
        thinking: execution.config.enableThinking,
        reasoningEffort: execution.config.reasoningEffort,
        webSearch: execution.config.webSearchMode === 'builtin',
        stream: execution.config.stream,
        approval: 'external' as const,
        maxExchanges: mode === 'agent' ? policy.maxExchanges : undefined,
        llmRetry: mode === 'agent' ? policy.llmRetry : undefined,
        toolTimeoutMs: mode === 'agent' ? policy.toolTimeoutMs : undefined,
    };
}
