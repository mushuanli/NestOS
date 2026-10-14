import { describe, expect, it } from 'vitest';
import type { FlowNodeDefinition } from '@itookit/llm-flow/contracts';
import { bindFlowNode, bindStandaloneFlowNode } from '../src/session/flow-node-binder';
import type { AgentResolver } from '../src/session/agent-resolver';

describe('bindFlowNode', () => {
    it('binds an invocation using only the target identity despite Session history and default prompts', async () => {
        const resolver = { resolveExact: async () => ({ id: 'reviewer', systemPrompt: ['TARGET'],
            memoryPolicy: { namespaceId: 'memory', readScopes: ['private'], writeScopes: [] } }),
            getSkills: async () => [], getSystemPrompt: async () => ({ content: [] }),
        } as unknown as AgentResolver;
        const node = { id: 'review', name: 'Review', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { agentId: 'reviewer', invocationContext: 'isolated', instruction: 'CHECK',
                messages: [{ role: 'assistant', content: 'OLD_TEMPLATE' }] } } as FlowNodeDefinition;
        const bound = await bindFlowNode(node, { systemPrompt: ['OLD_FLOW'] },
            { blocks: [{ kind: 'system', source: 'project', content: 'OLD_PROJECT' }],
                canonicalMessages: [{ role: 'user', content: 'OLD_HISTORY' }] } as never,
            { sessionId: 's', input: { text: 'OLD_INPUT' } } as never,
            { roundId: 'r', config: { id: 'session', name: 'Session', type: 'agent', systemPrompt: ['OLD_SESSION'] } }, resolver);
        expect((bound.config as any).invocationInstructions).toEqual(['TARGET', 'CHECK']);
        expect((bound.config as any).messages).toEqual([]);
        expect((bound.config as any).memoryPolicy).toBeUndefined();
        expect(JSON.stringify(bound)).not.toContain('OLD_');
    });
    it('freezes the node Agent memory authority without inheriting parent or inline grants', async () => {
        const memoryPolicy = { namespaceId: 'node', readScopes: ['project'], writeScopes: [] as string[] };
        const resolver = { resolveExact: async () => ({ id: 'node-agent', memoryPolicy }), getSkills: async () => [] } as unknown as AgentResolver;
        const node = { id: 'node', name: 'Node', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { agentId: 'node-agent', memoryPolicy: { namespaceId: 'inline', readScopes: [], writeScopes: ['private'] } } } as FlowNodeDefinition;
        const setup = { roundId: 'r', config: { id: 'parent', name: 'Parent', type: 'agent',
            memoryPolicy: { namespaceId: 'parent', readScopes: [], writeScopes: ['private'] } } };
        const bind = (config: unknown) => bindFlowNode({ ...node, config } as FlowNodeDefinition, undefined,
            { blocks: [], canonicalMessages: [] } as never, { sessionId: 's', input: { text: 'task' } } as never, setup as never, resolver);
        const bound = await bind(node.config);
        expect((bound.config as any).memoryPolicy).toEqual(memoryPolicy);
        memoryPolicy.writeScopes.push('later');
        expect((bound.config as any).memoryPolicy.writeScopes).toEqual([]);
        expect((await bind({ memoryPolicy: setup.config.memoryPolicy })).config).not.toHaveProperty('memoryPolicy');
    });
    it.each(['inherit', 'replace', 'none'])('resolves standalone Agent, prompt and Skill identities with %s policy', async policy => {
        const resolver = { resolveExact: async () => ({ id: 'reviewer', name: 'Reviewer', type: 'agent', model: 'agent-model',
            systemPrompt: ['agent rules'], capabilityPolicy: { toolIds: ['inspect'], skillIds: ['review'] } }),
            getSystemPrompt: async (id: string) => ({ content: [id] }),
            getSkills: async () => [{ id: 'review', enabled: true, instructions: 'skill rules', tools: [{ toolId: 'read' }] }],
        } as unknown as AgentResolver;
        const node = { id: 'node', name: 'Node', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: [],
            config: { agentId: 'reviewer', systemPromptId: 'node prompt', systemPrompt: ['node rules'], instruction: 'task',
                modelName: 'node-model', systemPromptPolicy: policy } } as FlowNodeDefinition;
        const bound = await bindStandaloneFlowNode(node, { systemPromptId: 'flow prompt', systemPrompt: ['flow rules'] } as never, 'session', resolver);
        const config = bound.config as any;
        expect(config.messages.map((message: any) => message.content)).toEqual(policy === 'none' ? ['task'] : [
            ...(policy === 'inherit' ? ['flow prompt', 'flow rules', 'agent rules'] : []), 'node prompt', 'skill rules', 'node rules', 'task',
        ]);
        expect(config.modelName).toBe('node-model');
        expect(config.sessionId).toBe('session');
        expect(bound.capabilities).toEqual(['inspect', 'read']);
    });

    it.each([undefined, 'explicit-model'])('uses selected Skill subagent models only for delegated children (%s)', async modelName => {
        const resolver = { getSkills: async () => [{ id: 'review', enabled: true, instructions: 'review rules', tools: [],
            supportsSubagent: true, subagentModel: 'skill-child-model' }],
        } as unknown as AgentResolver;
        const node = { id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { skillIds: ['review'], instruction: 'parent', delegation: { enabled: true,
                template: { skillIds: ['review'], contextSource: 'isolated', modelName } } } } as FlowNodeDefinition;
        const bound = await bindStandaloneFlowNode(node, { modelName: 'flow-model' } as never, 'session', resolver);
        const config = bound.config as any;
        expect(config.modelName).toBe('flow-model');
        expect(config.delegation.resolvedTemplate.config.modelName).toBe(modelName ?? 'skill-child-model');
    });

    it('rejects conflicting selected Skill child models before producing a delegation template', async () => {
        const resolver = { getSkills: async () => ['a', 'b'].map(id => ({ id, enabled: true, instructions: '', tools: [],
            supportsSubagent: true, subagentModel: id })) } as unknown as AgentResolver;
        const node = { id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { delegation: { enabled: true, template: { skillIds: ['a', 'b'] } } } } as FlowNodeDefinition;
        await expect(bindStandaloneFlowNode(node, undefined, 'session', resolver)).rejects.toThrow('conflicting subagent models');
    });

    it('snapshots selected Skill critical rules and excludes disabled or model-silent skills', async () => {
        const selected = { id: 'review', enabled: true, instructions: 'Review changes.',
            tools: [{ toolId: 'inspect' }], compact: { rawContent: 'Preserve access checks.' } };
        const resolver = { ...agents(), getSkills: async () => [selected,
            { ...selected, id: 'silent', disableModelInvocation: true, instructions: 'Silent instructions', tools: [{ toolId: 'silent-tool' }] },
            { ...selected, id: 'manual', triggerStrategy: 'action', instructions: 'Manual instructions', tools: [{ toolId: 'manual-tool' }] },
            { ...selected, id: 'disabled', enabled: false, instructions: 'Disabled instructions', tools: [{ toolId: 'disabled-tool' }] },
        ] } as unknown as AgentResolver;
        const node = { id: 'review', name: 'Review', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: { skillIds: ['review', 'silent', 'disabled', 'manual'] }, inputs: {}, capabilities: [] } as FlowNodeDefinition;
        const project = { kind: 'system', source: 'project', content: 'Project policy' };
        const routed = [{ kind: 'system', source: 'session-skill', content: 'Loaded rules' },
            { kind: 'system', source: 'skill-index', content: 'Available metadata' }];
        const patch = await bindFlowNode(node, undefined, { blocks: [project, ...routed], canonicalMessages: [{ role: 'user', content: 'task' }] } as never,
            { sessionId: 's', input: { text: 'task' } } as never,
            { roundId: 'r', config: { id: 'agent', name: 'Agent', type: 'agent' } }, resolver);
        const config = patch.config as unknown as { messages: Array<{ role: string; content: string }> };
        expect(config.messages).toEqual([
            { role: 'system', content: 'Project policy' },
            { role: 'system', content: 'Loaded rules' },
            { role: 'system', content: 'Available metadata' },
            { role: 'system', content: 'Review changes.' },
            { role: 'system', content: 'Skill review — critical rules:\nPreserve access checks.' },
            { role: 'user', content: 'task' },
        ]);
        expect(patch.capabilities).toEqual(['inspect']);
        selected.compact.rawContent = 'Edited later';
        expect(config.messages[4].content).toContain('Preserve access checks.');
        const none = await bindFlowNode({ ...node, config: { ...node.config, systemPromptPolicy: 'none' } } as FlowNodeDefinition,
            undefined, { blocks: [project, ...routed], canonicalMessages: [{ role: 'user', content: 'task' }] } as never,
            { sessionId: 's', input: { text: 'task' } } as never,
            { roundId: 'r', config: { id: 'agent', name: 'Agent', type: 'agent' } }, resolver);
        expect((none.config as unknown as typeof config).messages).toEqual([{ role: 'user', content: 'task' }]);
    });

    it('normalizes legacy fields and resolves an isolated child independently', async () => {
        const node = {
            id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: {
                prompt: 'legacy parent instruction',
                model: 'legacy-node-model',
                delegation: {
                    enabled: true,
                    template: { prompt: 'legacy child instruction', contextSource: 'isolated' },
                },
            },
            inputs: {}, capabilities: [],
        } as FlowNodeDefinition;
        const patch = await bindFlowNode(
            node,
            { modelName: 'flow-model' } as never,
            {
                canonicalMessages: [
                    { role: 'system', content: 'snapshot identity' },
                    { role: 'user', content: 'history' },
                ],
            } as never,
            { sessionId: 'session', input: { text: 'current task' } } as never,
            {
                roundId: 'round',
                config: {
                    id: 'session-agent', name: 'Session Agent', type: 'agent',
                    model: 'session-model', connectionId: 'default', systemPrompt: ['session identity'],
                },
            },
            agents(),
        );
        const config = patch.config as unknown as Record<string, any>;
        const child = config.delegation.resolvedTemplate.config as Record<string, any>;

        expect(config.modelName).toBe('legacy-node-model');
        expect(config.model).toBeUndefined();
        expect(config.instruction).toBe('legacy parent instruction');
        expect(config.includeDependencyOutputs).toBeUndefined();
        expect(child.instruction).toBe('legacy child instruction');
        expect(child.includeDependencyOutputs).toBe(false);
        expect(child.messages).toEqual([
            { role: 'system', content: 'session identity' },
            { role: 'system', content: 'legacy child instruction' },
        ]);
    });

    it.each([undefined, false, true])('keeps parent tool exchanges consistent when includeToolResults=%s', async includeToolResults => {
        const calls = [{ id: 'call', type: 'function', function: { name: 'inspect', arguments: '{}' } }];
        const messages = [{ role: 'user', content: 'review' },
            { role: 'assistant', content: 'Checking now', tool_calls: calls },
            { role: 'tool', content: 'secret result', tool_call_id: 'call' },
            { role: 'assistant', content: null, tool_calls: [{ ...calls[0], id: 'second' }] },
            { role: 'tool', content: 'second result', tool_call_id: 'second' }];
        const node = { id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
            config: { messages, delegation: { enabled: true, template: { contextSource: 'parent', includeToolResults } } } } as FlowNodeDefinition;
        const bound = await bindStandaloneFlowNode(node, undefined, 'session', { getSkills: async () => [] } as unknown as AgentResolver);
        const child = (bound.config as any).delegation.resolvedTemplate.config;
        expect(child.messages).toEqual(includeToolResults ? messages : [
            { role: 'user', content: 'review' }, { role: 'assistant', content: 'Checking now' },
        ]);
        expect(messages[1]).toHaveProperty('tool_calls');
        expect(messages).toHaveLength(5);
    });

    it.each(['isolated', 'upstream', 'parent'])('keeps standalone delegation child instruction for %s context', async contextSource => {
        const node = {
            id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
            config: {
                instruction: 'parent instruction',
                delegation: { enabled: true, template: { instruction: 'child instruction', contextSource } },
            },
            inputs: {}, capabilities: [],
        } as FlowNodeDefinition;
        const bound = await bindStandaloneFlowNode(node, undefined, 'session', { getSkills: async () => [] } as unknown as AgentResolver);
        const child = (bound.config as Record<string, any>).delegation.resolvedTemplate.config as Record<string, any>;
        const instruction = child.messages.filter((message: any) => message.content === 'child instruction');
        expect(instruction).toHaveLength(1);
        expect(instruction[0].role).toBe('system');
    });

    it('session context source keeps the session history for the child', async () => {
        const patch = await bindWithContext('session');
        const child = (patch.config as Record<string, any>).delegation.resolvedTemplate.config as Record<string, any>;
        expect(child.historyPolicy).toBe('inherit');
        expect(child.messages).toEqual([
            { role: 'system', content: 'child instruction' },
            { role: 'user', content: 'history' },
        ]);
    });

    it('parent context source merges parent system and body into the child', async () => {
        const patch = await bindWithContext('parent');
        const child = (patch.config as Record<string, any>).delegation.resolvedTemplate.config as Record<string, any>;
        expect(child.messages).toEqual([
            { role: 'system', content: 'parent instruction' },
            { role: 'system', content: 'child instruction' },
            { role: 'user', content: 'history' },
        ]);
    });

    it('upstream context source keeps only the child system messages', async () => {
        const patch = await bindWithContext('upstream');
        const child = (patch.config as Record<string, any>).delegation.resolvedTemplate.config as Record<string, any>;
        expect(child.messages).toEqual([
            { role: 'system', content: 'child instruction' },
        ]);
    });
});

function bindWithContext(contextSource: string) {
    const node = {
        id: 'parent', name: 'Parent', plugin: 'builtin.agent', pluginVersion: '1.0.0',
        config: {
            instruction: 'parent instruction',
            delegation: {
                enabled: true,
                template: { instruction: 'child instruction', contextSource },
            },
        },
        inputs: {}, capabilities: [],
    } as FlowNodeDefinition;
    return bindFlowNode(
        node,
        {} as never,
        {
            canonicalMessages: [
                { role: 'system', content: 'session identity' },
                { role: 'user', content: 'history' },
            ],
        } as never,
        { sessionId: 'session', input: { text: 'current task' } } as never,
        {
            roundId: 'round',
            config: {
                id: 'session-agent', name: 'Session Agent', type: 'agent',
                model: 'session-model', connectionId: 'default',
                systemPrompt: [],
            },
        },
        agents(),
    );
}

function agents(): AgentResolver {
    return {
        async resolveExact() { throw new Error('not configured'); },
        async getSystemPrompt() { return null; },
        async getSkills() { return []; },
    } as unknown as AgentResolver;
}
