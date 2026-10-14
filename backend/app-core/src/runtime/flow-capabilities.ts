import { bindStandaloneFlowNode, type FlowIdentityResolver } from '@itookit/llm-session';
import { resolveSessionSelectedSkills } from '@itookit/kernel-adapters';
import { buildSkillContexts } from '@itookit/llm-session';
import { DEFAULT_HARNESS_TOOL_IDS } from '../presets/harness-tools';
import { type FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import type { HeadlessKernelRuntime } from './create-kernel-runtime';

/** Shared capability binding for standalone Flow hosts. */
export function createFlowCapabilities(runtime: HeadlessKernelRuntime, identities?: Omit<FlowIdentityResolver, 'getSkills'>) {
    const resolveSkills = (sessionId: string, ids: string[]) =>
        resolveSessionSelectedSkills(runtime.kernel, runtime.sessions, sessionId, ids);
    const resolveMCPToolIds = async (sessionId: string, ids: string[]): Promise<string[]> => {
        const scope = await runtime.sessions.get(sessionId);
        if (!scope.resolveMCPToolIds) throw new Error('MCP profile resolution is unavailable');
        return scope.resolveMCPToolIds(ids);
    };
    const resolver: FlowIdentityResolver = {
        getMCPToolIds: (ids, sessionId) => resolveMCPToolIds(sessionId, ids),
        resolveExact: identities?.resolveExact.bind(identities) ?? (async id => { throw new Error(`Agent reference requires a host resolver: ${id}`); }),
        getSystemPrompt: identities?.getSystemPrompt.bind(identities) ?? (async id => { throw new Error(`System prompt reference requires a host resolver: ${id}`); }),
        getSkills: (ids, sessionId) => {
            if (!sessionId) throw new Error('Skill selection requires a Session');
            return resolveSkills(sessionId, ids);
        },
    };
    const resolveTools = async (sessionId: string, ids: string[]) => {
        const scope = await runtime.sessions.get(sessionId);
        await scope.prepareTools?.(ids);
        const tools = scope.toolService;
        for (const id of ids) if (!tools.getToolMeta(id)?.enabled) throw new Error(`Tool is missing or disabled: ${id}`);
        const allowed = new Set(ids);
        return { definitions: tools.getToolDefinitions().filter(tool => allowed.has(tool.function?.name ?? tool.name ?? '')),
            externalIds: ids.filter(id => tools.getToolMeta(id)?.sideEffect === 'external') };
    };
    const resolveHarnessToolIds = async (sessionId: string) => {
        const scope = await runtime.sessions.get(sessionId);
        return DEFAULT_HARNESS_TOOL_IDS
            .filter(id => scope.toolService.getToolMeta(id)?.enabled);
    };
    return { resolveSkills, resolveTools, resolveHarnessToolIds, resolveMCPToolIds,
        bindNode: (sessionId: string, node: FlowNodeDefinition, defaults?: FlowNodeDefinition['config']) =>
            bindStandaloneFlowNode(node, defaults, sessionId, resolver),
        resolveSkillContexts: async (sessionId: string, ids: string[], allowed: string[]) =>
            buildSkillContexts(await resolveSkills(sessionId, ids), await resolveTools(sessionId, allowed), allowed, new Set(ids)),
    };
}
