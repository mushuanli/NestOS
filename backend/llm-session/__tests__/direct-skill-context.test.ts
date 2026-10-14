import { FlowAggregateProgram } from '@itookit/llm-flow';
import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { DurableChatProgram } from '@itookit/llm-tasks';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';
import { skillContextResolver } from '../src/session/direct-conversation';

it.each([false, true])('persists selected Skill and scoped memory in direct chat Task input (memory: %s)', async withMemory => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/.kernel' }; } });
    kernel.registerProgram(new DurableChatProgram());
    kernel.registerProgram(new FlowAggregateProgram());
    await kernel.initialize();
    await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    try {
        const selected = { id: 'review', enabled: true, instructions: 'Review changes.',
            compact: { rawContent: 'Preserve access checks.' },
            tools: [{ toolId: 'inspect', definition: { name: 'inspect' } },
                { toolId: 'outside', definition: { name: 'outside' } },
                { toolId: 'missing', definition: { name: 'missing' } }] };
        const resolveSkills = vi.fn(async () => [selected,
            { ...selected, id: 'disabled', enabled: false, instructions: 'Disabled body' },
            { ...selected, id: 'silent', disableModelInvocation: true, instructions: 'Silent body' },
            { ...selected, id: 'unselected', instructions: 'Unselected body' },
            { ...selected, id: 'manual', triggerStrategy: 'action', instructions: 'Manual action body' },
        ]);
        const retrieveMemory = vi.fn(async () => withMemory ? [{ entryId: 'entry', namespaceId: 'agent-memory', contentHash: 'hash', content: 'Remember project constraints.' }] : []);
        // Only declared capabilities are exposed; a Skill tool without a matching definition is skipped.
        const resolveTools = vi.fn(async () => ({ definitions: [{ name: 'inspect' }, { name: 'outside' }],
            externalIds: ['inspect'] }));
        const coordinator = new ConversationRunCoordinator({ kernel, resolveSkills, retrieveMemory, resolveTools,
            resolveSessionContext: async () => ({ projectInstructions: 'Project rules from AGENT.md',
                skillInstructions: 'Loaded skill rules', skillIndex: 'Available skill metadata' }),
            engine: {}, eventBus: {}, dagPlugins: {}, loadArtifact: async () => null } as never);
        // Keep the actual context assembly, submission, and capability binding; bypass UI projection/consumption.
        const internal = coordinator as any;
        vi.spyOn(internal, 'startRound').mockResolvedValue(undefined);
        vi.spyOn(internal, 'projectRun').mockReturnValue(undefined);
        vi.spyOn(internal, 'consume').mockResolvedValue({ message: { role: 'assistant', content: 'done' } });
        vi.spyOn(internal, 'completeRound').mockResolvedValue(undefined);
        const execution = { task: { id: 'run', sessionId: 'session', input: { text: 'Please review' }, abortController: new AbortController() },
            config: { id: 'agent', systemPrompt: ['Agent identity'], defaultContextPolicy: { tokenBudget: withMemory ? 10000 : 1 },
                memoryPolicy: { namespaceId: 'agent-memory', readScopes: ['project'], writeScopes: [], retrievalLimit: 3 },
                capabilityPolicy: { skillIds: ['review', 'silent', 'disabled', 'manual'], toolIds: ['inspect'] } },
            log: { loadManifest: async () => ({ currentBranch: 'main', branches: { main: null }, branchMeta: {} }) },
            roundId: 'round', finalize: async () => {}, contextFiles: [] };
        await coordinator.executeDirect(execution as never);
        expect(retrieveMemory).toHaveBeenCalledWith(expect.objectContaining({ pendingUserMessage: expect.anything() }),
            { id: 'agent', version: 'unversioned' }, { sessionId: 'session', policy: execution.config.memoryPolicy });
        expect((retrieveMemory.mock.calls[0] as unknown as any[])[2].policy).not.toBe(execution.config.memoryPolicy);
        expect(resolveSkills).toHaveBeenCalledWith(['review', 'silent', 'disabled', 'manual'], 'session');
        selected.instructions = 'Later edit';
        selected.compact.rawContent = 'Later rules';
        const tasks = await kernel.listSessionTasks('session');
        expect(tasks).toHaveLength(1);
        expect((tasks[0].input as any).memoryPolicy).toEqual(execution.config.memoryPolicy);
        execution.config.memoryPolicy.writeScopes.push('later-write' as never);
        expect(((await kernel.listSessionTasks('session'))[0].input as any).memoryPolicy.writeScopes).toEqual([]);
        // Initial Skill selection activates the same snapshot shape as a runtime load_skill.
        expect((tasks[0].input as any).skillContexts).toEqual([{ skillId: 'review',
            compactInstructions: 'Preserve access checks.',
            tools: [{ toolId: 'inspect', definition: { name: 'inspect' }, external: true }] }]);
        expect((tasks[0].input as any).messages).toEqual([
            { role: 'system', content: 'Agent identity' },
            { role: 'system', content: 'Project rules from AGENT.md' },
            { role: 'system', content: 'Loaded skill rules' },
            ...(withMemory ? [{ role: 'system', content: 'Available skill metadata' }] : []),
            { role: 'system', content: 'Review changes.\n\nSkill review — critical rules:\nPreserve access checks.' },
            ...(withMemory ? [{ role: 'user', tags: ['context-reference'], content: 'Memory (agent-memory/entry):\nRemember project constraints.' }] : []),
            { role: 'user', content: 'Please review' },
        ]);
        resolveSkills.mockClear();
        execution.config.capabilityPolicy.skillIds = [];
        await coordinator.executeDirect(execution as never);
        expect(resolveSkills).not.toHaveBeenCalled();
        execution.config.capabilityPolicy.skillIds = ['review'];
        resolveSkills.mockRejectedValueOnce(new Error('catalog unavailable'));
        await expect(coordinator.executeDirect(execution as never)).rejects.toThrow('catalog unavailable');
        expect(await kernel.listSessionTasks('session')).toHaveLength(2);
        retrieveMemory.mockClear();
        retrieveMemory.mockRejectedValueOnce(new Error('Flow must not retrieve parent memory'));
        await coordinator.executeDag(execution as never, undefined, snapshot => {
            expect(snapshot.blocks.some(block => block.kind === 'memory')).toBe(false);
            expect(snapshot.canonicalMessages.some(message => String(message.content).includes('Remember project constraints.'))).toBe(false);
            return { nodes: [], edges: [] };
        });
        expect(retrieveMemory).not.toHaveBeenCalled();
    } finally { await kernel.dispose(); await manager.dispose(); }
});

it('builds Flow node Skill snapshots inside the node capability set', async () => {
    const resolveSkills = vi.fn(async (ids: string[]) => ids.map(id => ({ id, name: id, description: '', type: 'prompt', enabled: true,
        instructions: 'body', compact: { rawContent: 'critical' },
        tools: [{ toolId: 'inspect', definition: { name: 'inspect' } }, { toolId: 'outside', definition: { name: 'outside' } }] })));
    const resolveTools = vi.fn(async () => ({ definitions: [{ name: 'inspect' }, { name: 'outside' }], externalIds: [] }));
    const resolver = skillContextResolver({ resolveSkills, resolveTools } as never);
    expect(await resolver('session', ['review'], ['inspect'])).toEqual([{ skillId: 'review', compactInstructions: 'critical',
        tools: [{ toolId: 'inspect', definition: { name: 'inspect' }, external: false }] }]);
    expect(resolveTools).toHaveBeenCalledWith('session', ['inspect']);
    // A host without a Skill catalog resolves to no contexts instead of failing the node.
    expect(await skillContextResolver({} as never)('session', ['review'], [])).toEqual([]);
});
