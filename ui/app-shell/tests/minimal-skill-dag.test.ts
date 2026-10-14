// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVFS } from '@itookit/vfs-core';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { Kernel } from '@itookit/durable-kernel';
import { DurableAgentProgram } from '../../../backend/llm-tasks/src';
import { createKernelAdaptersRuntime } from '../../../backend/kernel-adapters/src/runtime/create-kernel-adapters-runtime';
import { createSessionSkillControls } from '../../../backend/kernel-adapters/src/skill/session-skill-controls';
import { buildSkillPromptContext } from '../../../backend/kernel-adapters/src/skill/prompt-context';
import { SkillPanel } from '../../llm-ui/src/components/input/SkillPanel';
import { DurableFlowExecutor } from '../../../backend/llm-flow/src/flow/executor';
import { createBuiltinDagPluginRegistry } from '../../../backend/llm-flow/src/flow/builtin-plugins';
import { FlowAggregateProgram, FlowHumanProgram, FlowValueProgram } from '../../../backend/llm-flow/src/flow/programs';
import { DagCommandService } from '../../../backend/llm-flow/src/flow/commands';
import { FlowCommand } from '../../../backend/llm-flow/src/flow/command-names';
import { restoreFlowHandle } from '../../../backend/llm-flow/src/flow/restore-handle';
import { readFlowTaskTranscript } from '../../../backend/llm-flow/src/flow/transcript';

async function openSystem(root: string) {
    const { manager } = await createVFS({ rootBackend: await openLocalFSBackend({ rootDir: join(root, 'files'), sidecarDir: join(root, 'db') }) });
    const fs = await manager.openFileSystem('/workspace');
    const kernel = new Kernel({ catalog: { fs }, pollMs: 0 });
    kernel.registerStorageResolver({ kind: 'local-test', async resolve() { return { fs, rootPath: '/session' }; } });
    kernel.registerProgram(new DurableAgentProgram());
    kernel.registerProgram(new FlowAggregateProgram());
    kernel.registerProgram(new FlowValueProgram());
    kernel.registerProgram(new FlowHumanProgram());
    await kernel.initialize();
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
    await runtime.skillCatalog.saveSkill({ id: 'review', name: 'Review', description: 'Review', type: 'prompt',
        enabled: true, instructions: 'Return a concise review.', tools: [], triggerPatterns: [], autoLoad: false, priority: 50 });
    return { kernel, runtime, controls: createSessionSkillControls(kernel, runtime.sessions),
        async dispose() { kernel.dispose(); await kernel.waitIdle(); await runtime.dispose(); await manager.dispose(); } };
}

it('loads a Skill from the panel, runs an Agent DAG and reopens persisted results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'minimal-skill-dag-'));
    let system = await openSystem(root);
    try {
        await system.kernel.createSession({ id: 'minimal', storage: { kind: 'local-test', locator: null } });
        const element = document.createElement('div');
        element.innerHTML = '<section class="llm-input__skill-section"><div class="llm-input__skills-list"></div></section>';
        const panel = new SkillPanel(element, { onRequestSkills: () => system.controls.list('minimal'),
            onLoadSkill: id => system.controls.load('minimal', id), onUnloadSkill: id => system.controls.unload('minimal', id) });
        await panel.reload();
        const checkbox = element.querySelector<HTMLInputElement>('input')!;
        checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(async () => expect((await system.controls.listLoaded('minimal')).map(skill => skill.id)).toEqual(['review']));
        const scope = await system.runtime.sessions.get('minimal');
        const prompt = await buildSkillPromptContext(scope.skillService);
        expect(prompt.skillInstructions).toContain('Return a concise review.');
        const model = vi.fn(async (request: any) => {
            expect(request.request.messages).toContainEqual(expect.objectContaining({ role: 'system', content: prompt.skillInstructions }));
            return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Review complete.' } }] };
        });
        system.kernel.registerEffect({ kind: 'llm.chat', version: '1', execute: model });
        const run = await new DurableFlowExecutor({ kernel: system.kernel, plugins: createBuiltinDagPluginRegistry() }).submit('minimal', {
            nodes: [{ id: 'review', name: 'Review', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, capabilities: [],
                config: { sessionId: 'minimal', roundId: 'one', connectionId: 'test', approval: 'none',
                    messages: [{ role: 'system', content: prompt.skillInstructions }, { role: 'user', content: 'Review this change.' }] } },
                { id: 'result', name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                    config: { operation: 'identity', outputName: 'result', type: 'text', value: null } }],
            edges: [{ id: 'review-result', from: 'review', to: 'result', input: 'input', output: 'result' }],
        });
        const exit = await run.root.wait({ timeoutMs: 2000 });
        expect(exit.status).toBe('succeeded'); expect(model).toHaveBeenCalledTimes(1);
        expect(JSON.stringify((await run.nodes.get('result')!.status()).task.output)).toContain('Review complete.');
        const taskId = run.nodes.get('review')!.id;
        const transcript = await readFlowTaskTranscript(system.kernel, 'minimal', run.root.id, taskId);
        expect(JSON.stringify(transcript)).toContain('Review complete.');
        await system.dispose(); system = await openSystem(root);
        const session = await system.kernel.openSession('minimal');
        const restored = await restoreFlowHandle(session, run.root.id);
        expect(await restored.root.wait()).toEqual(exit);
        expect(await readFlowTaskTranscript(system.kernel, 'minimal', run.root.id, taskId)).toEqual(transcript);
        const loaded = await session.getShared('kernel-adapters.skills.loaded');
        const restoredScope = await system.runtime.sessions.restore('minimal', loaded?.value);
        expect((await buildSkillPromptContext(restoredScope.skillService)).skillInstructions).toBe(prompt.skillInstructions);
    } finally { await system.dispose(); await rm(root, { recursive: true, force: true }); }
});

it.each([false, true])('continues downstream DAG nodes after Run responses (repeated interaction: %s)', async repeated => {
    const root = await mkdtemp(join(tmpdir(), 'minimal-human-dag-'));
    const system = await openSystem(root);
    try {
        await system.kernel.createSession({ id: 'minimal', storage: { kind: 'local-test', locator: null } });
        const plugins = createBuiltinDagPluginRegistry();
        const run = await new DurableFlowExecutor({ kernel: system.kernel, plugins }).submit('minimal', {
            nodes: [{ id: 'answer', name: 'Answer', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {},
                config: { requestId: 'answer', prompt: 'Choose' } },
            ...(repeated ? [{ id: 'followup', name: 'Followup', plugin: 'builtin.human', pluginVersion: '1.0.0', inputs: {},
                config: { requestId: 'answer', prompt: 'Confirm again' } }] : []),
            { id: 'result', name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: { operation: 'identity', outputName: 'result', type: 'text', value: null } }],
            edges: [...(repeated ? [{ id: 'followup-edge', from: 'answer', to: 'followup', input: 'input', output: 'result' }] : []),
                { id: 'answer-result', from: repeated ? 'followup' : 'answer', to: 'result', input: 'input', output: 'result' }],
        });
        const handlers = new Map<string, (args: unknown) => Promise<any>>();
        new DagCommandService({ kernel: system.kernel, plugins, flowStore: {} as never })
            .register({ register: (name: string, handler: any) => handlers.set(name, handler) } as never);
        await handlers.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'minimal' });
        await handlers.get(FlowCommand.RunRespond)!({ taskId: run.root.id, targetTaskId: run.nodes.get('answer')!.id,
            requestId: 'answer', value: 'approved' });
        if (repeated) {
            let targetTaskId = '';
            await vi.waitFor(async () => {
                const current = await handlers.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'minimal' });
                const followup = current.nodes.find((node: any) => node.nodeId === 'followup')?.snapshot.task;
                expect(followup?.interactions.answer.status).toBe('pending'); targetTaskId = followup.id;
                expect(current.root.task.status).not.toBe('succeeded');
            });
            await handlers.get(FlowCommand.RunRespond)!({ taskId: run.root.id, targetTaskId, requestId: 'answer', value: 'approved twice' });
        }
        expect((await run.root.wait({ timeoutMs: 2000 })).status).toBe('succeeded');
        const snapshot = await handlers.get(FlowCommand.RunGet)!({ taskId: run.root.id, sessionId: 'minimal' });
        const result = snapshot.nodes.find((node: any) => node.nodeId === 'result');
        expect(result).toBeDefined();
        expect(JSON.stringify(result.snapshot.task.output)).toContain('approved');
        const restored = await restoreFlowHandle(await system.kernel.openSession('minimal'), run.root.id);
        expect(restored.nodes.get('result')?.id).toBe(result.snapshot.task.id);
    } finally { await system.dispose(); await rm(root, { recursive: true, force: true }); }
});
