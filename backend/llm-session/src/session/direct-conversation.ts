import type { ConversationExecution, ConversationRunCoordinatorOptions } from './conversation-run-coordinator';
import type { ContextSnapshot, ToolDefinition } from '@itookit/llm-context';
import type { TaskSpec } from '@itookit/durable-kernel';
import type { LLMSkill } from '../contracts';
import type { ResolvedDirectAgentPolicy } from '../contracts/direct-agent-policy';
import { buildLlmTaskInput, buildSkillContexts, type DurableAgentInput, type SkillContext } from '@itookit/llm-tasks';
import { CLIENT_WEB_SEARCH_TOOL, directExecutionMode, directToolIds } from './direct-execution-mode';

export async function prepareDirectConversation(options: ConversationRunCoordinatorOptions, execution: ConversationExecution) {
    if (directExecutionMode(execution.task.input) === 'agent' && execution.config.capabilityPolicy?.toolIds === undefined) {
        const toolIds = await options.resolveHarnessToolIds?.(execution.task.sessionId) ?? [];
        execution = { ...execution, config: { ...execution.config,
            capabilityPolicy: { mcpProfileIds: [], ...execution.config.capabilityPolicy, toolIds } } };
    }
    const profiles = execution.config.capabilityPolicy?.mcpProfileIds ?? [];
    if (profiles.length && directExecutionMode(execution.task.input) !== 'chat') {
        if (!options.resolveMCPToolIds) throw new Error('MCP profile resolution is unavailable');
        const mcpIds = await options.resolveMCPToolIds(execution.task.sessionId, profiles);
        const policy = execution.config.capabilityPolicy!;
        execution = { ...execution, config: { ...execution.config,
            capabilityPolicy: { ...policy, toolIds: [...new Set([...(policy.toolIds ?? []), ...mcpIds])] } } };
    }
    const ids = execution.config.capabilityPolicy?.skillIds ?? [];
    const skills = ids.length ? await options.resolveSkills?.(ids, execution.task.sessionId) ?? [] : [];
    const skillsPrompt = skills.filter(skill => ids.includes(skill.id) && skill.enabled && !skill.disableModelInvocation && skill.triggerStrategy !== 'action')
        .flatMap(skill => [skill.instructions,
            skill.compact?.rawContent ? `Skill ${skill.id} — critical rules:\n${skill.compact.rawContent}` : '',
        ]).filter(Boolean).join('\n\n');
    return { execution, skills, skillsPrompt };
}

export function directTaskSpec(
    execution: ConversationExecution,
    snapshot: ContextSnapshot,
    catalog: { definitions: ToolDefinition[]; externalIds: string[] },
    skills: LLMSkill[],
    policy: ResolvedDirectAgentPolicy,
): TaskSpec<DurableAgentInput> {
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

/**
 * Host-side Skill activation port for Flow Agent nodes: resolves the selected Skills and
 * binds their tools against the same catalog the node itself is allowed to use.
 */
export function skillContextResolver(options: Pick<ConversationRunCoordinatorOptions, 'resolveSkills' | 'resolveTools'>) {
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

function directBindings(execution: ConversationExecution, catalog: { definitions: ToolDefinition[]; externalIds: string[] }, skills: LLMSkill[], tools: string[]) {
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
function directInput(execution: ConversationExecution, snapshot: ContextSnapshot, policy: ResolvedDirectAgentPolicy) {
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
