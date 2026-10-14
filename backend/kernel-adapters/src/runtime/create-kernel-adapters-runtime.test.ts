import { parseLoadedSkillIds } from '../skill/loaded-state';
import { runSessionSkillOperation } from '../skill/operation-queue';
import { createSessionSkillControls } from '../skill/session-skill-controls';
import { describe, expect, it, vi } from 'vitest';
import type {
    DurableTaskProgram,
    EffectAdapter,
    EffectExecutionContext,
    KernelRegistration,
    JsonValue,
    SharedStateEntry,
} from '@itookit/durable-kernel';
import type { IDeviceDriver } from '@itookit/vfs-core';
import type { SkillDefinition } from '@itookit/tools/contracts';
import type { ITTYDriver } from '@itookit/tools/contracts';
import { ToolDeviceDriver } from '@itookit/tools';
import { createKernelAdaptersRuntime } from './create-kernel-adapters-runtime';
import { buildSkillPromptContext } from '../skill/prompt-context';
import { ApprovedEffectProgram } from '../programs/approved-effect-program';

describe('createKernelAdaptersRuntime', () => {
    it.each([false, true])('distinguishes file-only sessions from attached process backends (%s)', async attached => {
        const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '', code: 0 }));
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            logger: { debug() {}, info() {}, warn() {}, error: log },
            fileContextForSession: async () => ({ cwd: '/workspace',
                vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] },
                nativeShell: attached ? { capabilities: { ripgrep: false, fd: false }, exec } : undefined,
                release: async () => {} }),
        });
        try {
            const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
            const ctx = context(sessionState());
            ctx.grants = [{ ...ctx.grants[0], handleId: 'process-handle', resource: { ...ctx.grants[0].resource, kind: 'process' } }];
            const result = effects.find(effect => effect.kind === 'process.exec')!.execute({ resourceHandleId: 'process-handle', command: 'ls' }, ctx);
            if (attached) { expect(await result).toMatchObject({ success: true }); expect(exec).toHaveBeenCalled(); }
            else {
                await expect(result).rejects.toMatchObject({ code: 'ECAPABILITY', operation: 'process.exec', path: '/workspace' });
                expect(exec).not.toHaveBeenCalled();
                expect(log).toHaveBeenCalledWith('[process.context] No execution backend', expect.objectContaining({ cwd: '/workspace', shellAttached: false }));
            }
        } finally { await runtime.dispose(); log.mockRestore(); }
    });
    it('routes real tool Effects to independent Run files and shells and tombstones closed scopes', async () => {
        const opened: string[] = [], released: string[] = [];
        const files = async (id: string) => {
            opened.push(id);
            return { cwd: '/workspace', vfs: {
                readFile: async () => id, writeFile: async () => {}, listFiles: async () => [],
            }, nativeShell: { capabilities: { ripgrep: false, fd: false },
                exec: async () => ({ stdout: id, stderr: '', code: 0 }) },
            release: async () => { released.push(id); } };
        };
        const select = vi.fn(async (effect: EffectExecutionContext) => effect.taskId === 'normal' ? undefined : effect.taskId);
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: () => files('normal'),
            scopeForEffect: select,
            fileContextForScope: (session, run) => files(`${session}:${run}`),
        });
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        const invoke = async (taskId: string, toolId = 'Read') => tool.execute({
            resourceHandleId: 'tool-handle', toolId,
            args: toolId === 'Read' ? { file_path: '/workspace/file.txt' } : { command: 'pwd' },
        }, { ...context(sessionState()), taskId, effectId: crypto.randomUUID() });
        try {
            const results = await Promise.all(['one', 'two', 'normal'].map(id => invoke(id)));
            expect(JSON.stringify(results[0])).toContain('session-a:one');
            expect(JSON.stringify(results[1])).toContain('session-a:two');
            expect(JSON.stringify(results[2])).toContain('normal');
            expect(JSON.stringify(await invoke('one', 'Bash'))).toContain('session-a:one');
            expect(opened.sort()).toEqual(['normal', 'session-a:one', 'session-a:two']);
            expect(select).toHaveBeenCalledTimes(4);
            await runtime.disposeScope('session-a', 'one');
            await expect(invoke('one')).rejects.toThrow('closed');
            expect(JSON.stringify(await invoke('two'))).toContain('session-a:two');
            await runtime.disposeScope('session-a', 'not-opened');
            await expect(invoke('not-opened')).rejects.toThrow('closed');
            await runtime.disposeSession('session-a');
            expect(released.sort()).toEqual(['normal', 'session-a:one', 'session-a:two']);
        } finally { await runtime.dispose(); }
        expect(released).toHaveLength(3);
    });

    it('shares in-flight Run cleanup and does not open a scope after Session disposal', async () => {
        let stopped!: () => void;
        const stopping = new Promise<void>(resolve => { stopped = resolve; });
        const release = vi.fn(() => stopping);
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            scopeForEffect: async () => 'run', fileContextForScope: async () => ({ cwd: '/',
                vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] }, release }),
        });
        try {
            await runtime.sessions.getForEffect!(context(sessionState()));
            let finished = 0;
            const first = runtime.disposeScope('session-a', 'run').then(() => { finished++; });
            const second = runtime.disposeScope('session-a', 'run').then(() => { finished++; });
            await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
            expect(finished).toBe(0);
            stopped();
            await Promise.all([first, second]);
            expect(finished).toBe(2);
        } finally { stopped(); await runtime.dispose(); }
        await expect(runtime.sessions.getForEffect!(context(sessionState()))).rejects.toThrow('closing');
    });

    it('retries a failed Run release while refusing late capability acquisition', async () => {
        const release = vi.fn().mockRejectedValueOnce(new Error('release failed')).mockResolvedValue(undefined);
        const acquire = vi.fn(async () => ({ cwd: '/',
            vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] }, release }));
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            scopeForEffect: async () => 'run', fileContextForScope: acquire });
        try {
            await runtime.sessions.getForEffect!(context(sessionState()));
            await expect(runtime.disposeScope('session-a', 'run')).rejects.toThrow('release failed');
            await expect(runtime.sessions.getForEffect!(context(sessionState()))).rejects.toThrow('closed');
            await Promise.all([runtime.disposeScope('session-a', 'run'), runtime.disposeScope('session-a', 'run')]);
            expect(release).toHaveBeenCalledTimes(2);
            expect(acquire).toHaveBeenCalledOnce();
            await runtime.disposeScope('session-a', 'run');
            expect(release).toHaveBeenCalledTimes(2);
        } finally { await runtime.dispose(); }
    });

    it('keeps a failed Session close blocked until its original resources are released', async () => {
        const release = vi.fn().mockRejectedValueOnce(new Error('release failed')).mockResolvedValue(undefined);
        const acquire = vi.fn(async () => ({ cwd: '/',
            vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] }, release }));
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: acquire });
        try {
            await runtime.sessions.get('session-a');
            await expect(runtime.disposeSession('session-a')).rejects.toThrow('release failed');
            await expect(runtime.sessions.get('session-a')).rejects.toThrow('closing');
            await runtime.disposeSession('session-a');
            expect(release).toHaveBeenCalledTimes(2);
            expect(acquire).toHaveBeenCalledOnce();
            await runtime.sessions.get('session-a');
            expect(acquire).toHaveBeenCalledTimes(2);
        } finally { await runtime.dispose(); }
    });

    it('never falls back to Session files if isolated scope selection or acquisition fails', async () => {
        const normal = vi.fn(async () => ({ cwd: '/', vfs: {
            readFile: async () => 'base', writeFile: async () => {}, listFiles: async () => [],
        }, release: async () => {} }));
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: normal, scopeForEffect: async ctx => {
                if (ctx.taskId === 'missing') throw new Error('Run lease missing');
                return 'isolated';
            }, fileContextForScope: async () => { throw new Error('Worktree missing'); },
        });
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const effect = effects.find(effect => effect.kind === 'tool.call')!;
        try {
            for (const taskId of ['missing', 'present']) await expect(effect.execute({
                resourceHandleId: 'tool-handle', toolId: 'Read', args: { file_path: '/workspace/file' },
            }, { ...context(sessionState()), taskId })).rejects.toThrow(/missing/);
            expect(normal).not.toHaveBeenCalled();
        } finally { await runtime.dispose(); }
    });

    it('releases acquired views when the Session skill scan fails', async () => {
        let released = 0;
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: async () => ({ cwd: '/workspace', vfs: {
                readFile: async () => '', writeFile: async () => {}, listFiles: async () => [],
            }, release: async () => { released++; } }),
            skillSourceForSession: () => ({ loadScope: async () => { throw new Error('view revoked'); } }),
        });
        try {
            await expect(runtime.sessions.get('one')).rejects.toThrow('view revoked');
            expect(released).toBe(1);
        } finally { await runtime.dispose(); }
        expect(released).toBe(1);
    });

    it('assembles services and registers durable capability effects', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        const effects: EffectAdapter[] = [];
        const programs: DurableTaskProgram[] = [];
        runtime.plugin.install(registration(effects, programs));

        expect(runtime.toolCatalog.getToolMeta('load_skill')).toBeDefined();
        expect(runtime.toolCatalog.getToolMeta('human_input')).toBeUndefined();
        expect(effects.map(effect => effect.kind)).toEqual([
            'llm.chat', 'tool.call', 'process.exec', 'skill.load', 'skill.unload',
        ]);
        expect(programs.map(program => program.manifest.kind)).toEqual([
            'kernel-adapters.approved-effect', 'kernel-adapters.exec',
        ]);

        await runtime.dispose();
    });

    it('has no global execution service and denies file IO without a Session grant', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        expect('toolService' in runtime).toBe(false);
        expect('toolDriver' in runtime).toBe(false);
        const scope = await runtime.sessions.get('unconfigured');
        const result = await scope.toolService.invoke({ toolId: 'Read', args: { file_path: '/etc/passwd' } });
        expect(result.success).toBe(false);
        await runtime.dispose();
    });

    it('isolates loaded Skill state between durable sessions', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const first = await runtime.sessions.get('session-a');
        const second = await runtime.sessions.get('session-b');

        await first.skillService.loadSkill('review');

        expect(first.skillService.getLoadedSkills().map(skill => skill.id)).toEqual(['review']);
        expect(second.skillService.getLoadedSkills()).toEqual([]);
        expect(first.toolService).not.toBe(second.toolService);
        await runtime.dispose();
    });

    it('releases and recreates a session capability scope', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        const first = await runtime.sessions.get('session-a');

        await runtime.disposeSession('session-a');
        const recreated = await runtime.sessions.get('session-a');

        expect(recreated).not.toBe(first);
        await runtime.dispose();
    });

    it('acquires independent file contexts, retries failed acquisition, and releases each once', async () => {
        const calls: string[] = [], released: string[] = [];
        let fail = true;
        const runtime = await createKernelAdaptersRuntime({
            llmDriver: {} as IDeviceDriver,
            fileContextForSession: async id => {
                calls.push(id);
                if (id === 'retry' && fail) { fail = false; throw new Error('Unavailable source'); }
                return { cwd: '/workspace', vfs: {
                    readFile: async () => id, writeFile: async () => {}, listFiles: async () => [],
                }, release: async () => { released.push(id); } };
            },
        });
        expect(calls).toEqual([]);
        const [a, duplicate, b] = await Promise.all([runtime.sessions.get('a'), runtime.sessions.get('a'), runtime.sessions.get('legacy')]);
        expect(a).toBe(duplicate);
        expect(a).not.toBe(b);
        expect(calls).toEqual(['a', 'legacy']);
        const readA = await a.toolService.invoke({ toolId: 'Read', args: { file_path: '/workspace/same.md' } });
        const readB = await b.toolService.invoke({ toolId: 'Read', args: { file_path: '/workspace/same.md' } });
        expect(readA.success).toBe(true);
        expect(readA.output).toContain('a');
        expect(readB.success).toBe(true);
        expect(readB.output).toContain('legacy');
        await expect(runtime.sessions.get('retry')).rejects.toThrow('Unavailable source');
        await runtime.sessions.get('retry');
        await runtime.disposeSession('a');
        await runtime.disposeSession('a');
        await runtime.dispose();
        expect(released.sort()).toEqual(['a', 'legacy', 'retry']);
        await expect(runtime.sessions.get('after-close')).rejects.toThrow('closed');
    });

    it('waits for approval before dispatching a protected effect', async () => {
        const program = new ApprovedEffectProgram();
        const input = {
            prompt: 'Allow request?',
            effect: {
                id: 'llm', kind: 'llm.chat', version: '1', request: {}, idempotencyKey: 'llm',
            },
        };
        const initial = program.init(input);

        const approved = program.reduce(initial.state, {
            type: 'interaction-resolved', interactionId: 'approve:llm', value: true,
        });

        expect(initial.next.type).toBe('wait');
        expect(approved.actions).toEqual([{ type: 'effect', effect: input.effect }]);
        expect(approved.next).toEqual({ type: 'wait', on: { type: 'effect', id: 'llm' } });
    });

    it('shares restoration and rejects an old restoration after its scope is disposed', async () => {
        const released = vi.fn();
        let waiting = true, entered!: () => void, finish!: (value: string) => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: async () => ({ cwd: '/workspace', release: released, vfs: {
                writeFile: async () => {}, listFiles: async () => [], readFile: async () => {
                    if (!waiting) return 'fresh';
                    entered(); return new Promise<string>(resolve => { finish = resolve; });
                },
            } }),
        });
        try {
            await runtime.skillCatalog.saveSkill({ ...skillDefinition(), fsRoot: '/workspace', referencePaths: ['ref.md'] });
            const old = runtime.sessions.restore('session-a', ['review']);
            expect(runtime.sessions.restore('session-a', ['review'])).toBe(old);
            const rejected = expect(old).rejects.toThrow('changed');
            await started;
            const closing = runtime.disposeSession('session-a');
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(released).not.toHaveBeenCalled();
            finish('late');
            await rejected; await closing;
            expect(released).toHaveBeenCalledOnce();
            waiting = false;
            const current = await runtime.sessions.restore('session-a', ['review']);
            expect(current.skillService.getLoadedSkills().map(skill => skill.id)).toEqual(['review']);
            expect(await runtime.sessions.restore('session-a', ['review'])).toBe(current);
        } finally { finish?.('cleanup'); await runtime.dispose(); }
    });

    it('restores loaded identities before prompt assembly and preserves explicit unload in the live scope', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = [];
        runtime.plugin.install(registration(effects));
        const state = sessionState();
        await effects.find(effect => effect.kind === 'skill.load')!.execute(
            { resourceHandleId: 'skill-handle', skillId: 'review' }, context(state));
        await runtime.disposeSession('session-a');
        const saved = await state.get('kernel-adapters.skills.loaded');
        const scope = await runtime.sessions.restore('session-a', saved?.value);
        expect((await buildSkillPromptContext(scope.skillService)).skillInstructions).toContain('Skill review:');
        await scope.skillService.unloadSkill('review');
        await runtime.sessions.restore('session-a', saved?.value);
        expect(scope.skillService.getLoadedSkills()).toEqual([]);
        await runtime.dispose();
    });

    it('rejects corrupt identities and model-disabled definitions during restoration', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        try {
            await runtime.skillCatalog.saveSkill({ ...skillDefinition(), disableModelInvocation: true });
            await expect(runtime.sessions.restore('session-a', ['review'])).rejects.toThrow('cannot be restored');
            expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills()).toEqual([]);
            await expect(runtime.sessions.restore('session-a', ['review', 42])).rejects.toThrow('Invalid loaded');
        } finally { await runtime.dispose(); }
    });

    it('durably unloads a Skill and does not restore it after scope reconstruction', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        try {
            await runtime.skillCatalog.saveSkill(skillDefinition());
            const effects: EffectAdapter[] = [];
            runtime.plugin.install(registration(effects));
            const state = sessionState(), ctx = context(state);
            await effects.find(effect => effect.kind === 'skill.load')!.execute({ resourceHandleId: 'skill-handle', skillId: 'review' }, ctx);
            const unload = effects.find(effect => effect.kind === 'skill.unload')!;
            await unload.execute({ resourceHandleId: 'skill-handle', skillId: 'review' }, ctx);
            expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
            await runtime.disposeSession('session-a');
            const restored = await runtime.sessions.restore('session-a', (await state.get('kernel-adapters.skills.loaded'))?.value);
            expect(restored.skillService.getLoadedSkills()).toEqual([]);
            // Cleanup remains possible after a saved definition has been removed from the catalog.
            await state.set('kernel-adapters.skills.loaded', ['missing'], (await state.get('kernel-adapters.skills.loaded'))!.version);
            await unload.execute({ resourceHandleId: 'skill-handle', skillId: 'missing' }, ctx);
            expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        } finally { await runtime.dispose(); }
    });

    it('restores loaded Skills from durable session shared state', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = [];
        runtime.plugin.install(registration(effects));
        const state = sessionState();
        const effectContext = context(state);
        const skill = effects.find(effect => effect.kind === 'skill.load')!;
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        await skill.execute({ resourceHandleId: 'skill-handle', skillId: 'review' }, effectContext);
        await runtime.disposeSession('session-a');

        await tool.execute({
            resourceHandleId: 'tool-handle', toolId: 'missing', args: {},
        }, effectContext).catch(() => undefined);

        const restored = await runtime.sessions.get('session-a');
        expect(restored.skillService.getLoadedSkills().map(value => value.id)).toEqual(['review']);
        await runtime.dispose();
    });

    it('returns Skill instructions through the tool Effect and restores its loaded state', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill({ ...skillDefinition(), instructions: 'Inspect authorization before writes.',
            compact: { marker: 'Compact Instructions', redLines: ['Keep access checks.'], rawContent: 'Keep access checks.' } });
        const effects: EffectAdapter[] = [];
        runtime.plugin.install(registration(effects));
        const effectContext = context(sessionState());
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        const result = await tool.execute({ resourceHandleId: 'tool-handle', toolId: 'load_skill',
            args: { skill_id: 'review' } }, effectContext) as { output: string };
        expect(result.output).toContain('Inspect authorization before writes.');
        expect(result.output).toContain('Keep access checks.');
        expect(result).toMatchObject({ skillContext: { skillId: 'review', compactInstructions: 'Keep access checks.' } });
        await runtime.disposeSession('session-a');
        await tool.execute({ resourceHandleId: 'tool-handle', toolId: 'missing', args: {} }, effectContext).catch(() => undefined);
        expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills().map(s => s.id)).toEqual(['review']);
        await runtime.skillCatalog.saveSkill({ ...skillDefinition(), instructions: 'Updated instructions.' });
        expect(result.output).toContain('Inspect authorization before writes.');
        expect(result).toMatchObject({ skillContext: { compactInstructions: 'Keep access checks.' } });
        await runtime.dispose();
    });

    it('snapshots only registered enabled bindings from the loaded Skill', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            skillToolHandlerFactory: { create: () => async () => 'published' } });
        await runtime.skillCatalog.saveSkill({ ...skillDefinition(), tools: [
            { toolId: 'publish', executionType: 'http', definition: { name: 'publish', description: 'Publish review' } },
            { toolId: 'absent', executionType: 'builtin', definition: { name: 'absent' } },
        ] });
        const effects: EffectAdapter[] = [];
        runtime.plugin.install(registration(effects));
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        const result = await tool.execute({ resourceHandleId: 'tool-handle', toolId: 'load_skill',
            args: { skill_id: 'review' } }, context(sessionState())) as import('@itookit/tools/contracts').ToolInvokeResult;
        expect(result.skillContext?.tools).toEqual([
            { toolId: 'publish', definition: { name: 'publish', description: 'Publish review' }, external: true },
        ]);
        await runtime.dispose();
    });

    it('unloads through the tool Effect durably and can forget a deleted definition after reconstruction', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        const state = sessionState(), ctx = context(state);
        const request = { resourceHandleId: 'tool-handle', args: { skill_id: 'review' } };
        await tool.execute({ ...request, toolId: 'load_skill' }, ctx);
        expect(runtime.toolCatalog.getToolDefinitions().some(tool => (tool.name ?? tool.function?.name) === 'unload_skill')).toBe(true);
        await tool.execute({ ...request, toolId: 'unload_skill' }, ctx);
        expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills()).toEqual([]);
        expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        await runtime.disposeSession('session-a');
        await tool.execute({ ...request, toolId: 'missing' }, ctx).catch(() => undefined);
        expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills()).toEqual([]);
        await tool.execute({ ...request, toolId: 'load_skill' }, ctx);
        await runtime.skillCatalog.deleteSkill('review');
        await runtime.disposeSession('session-a');
        await tool.execute({ ...request, toolId: 'unload_skill' }, ctx);
        expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        await runtime.dispose();
    });

    it.each(['skill.load', 'tool.call'])('rolls back a newly loaded Skill when identity persistence fails (%s)', async kind => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const state = sessionState(), ctx = context(state);
        state.set = async () => { throw new Error('storage unavailable'); };
        const adapter = effects.find(effect => effect.kind === kind)!;
        await expect(adapter.execute(kind === 'tool.call'
            ? { resourceHandleId: 'tool-handle', toolId: 'load_skill', args: { skill_id: 'review' } }
            : { resourceHandleId: 'skill-handle', skillId: 'review' }, ctx)).rejects.toThrow('storage unavailable');
        expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills()).toEqual([]);
        await runtime.dispose();
    });

    it.each(['skill.load', 'tool.call'])('keeps a Skill that was already live when identity persistence fails (%s)', async kind => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const state = sessionState(), ctx = context(state);
        const scope = await runtime.sessions.get('session-a');
        await scope.skillService.loadSkill('review');
        state.set = async () => { throw new Error('storage unavailable'); };
        const adapter = effects.find(effect => effect.kind === kind)!;
        await expect(adapter.execute(kind === 'tool.call'
            ? { resourceHandleId: 'tool-handle', toolId: 'load_skill', args: { skill_id: 'review' } }
            : { resourceHandleId: 'skill-handle', skillId: 'review' }, ctx)).rejects.toThrow('storage unavailable');
        expect(scope.skillService.getLoadedSkills().map(skill => skill.id)).toEqual(['review']);
        await runtime.dispose();
    });

    it('finishes scope cleanup after a release failure and preserves the original cause', async () => {
        const dispose = vi.spyOn(ToolDeviceDriver.prototype, 'dispose');
        try {
            const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
                fileContextForSession: async () => ({ cwd: '/workspace', vfs: {
                    readFile: async () => '', writeFile: async () => {}, listFiles: async () => [],
                }, release: async () => { throw new Error('release failed'); } }),
                skillSourceForSession: () => ({ loadScope: async () => { throw new Error('scan failed'); } }),
            });
            const failure = await runtime.sessions.get('one').catch(error => error);
            expect(dispose).toHaveBeenCalled();
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors.map(error => (error as Error).message))
                .toEqual(['scan failed', 'release failed']);
            await runtime.dispose();
        } finally { dispose.mockRestore(); }
    });

    it('keeps a Skill live when durable tool unload persistence fails', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const tool = effects.find(effect => effect.kind === 'tool.call')!;
        const state = sessionState(), ctx = context(state);
        const request = { resourceHandleId: 'tool-handle', args: { skill_id: 'review' } };
        await tool.execute({ ...request, toolId: 'load_skill' }, ctx);
        state.set = async () => { throw new Error('storage unavailable'); };
        await expect(tool.execute({ ...request, toolId: 'unload_skill' }, ctx)).rejects.toThrow('storage unavailable');
        expect((await runtime.sessions.get('session-a')).skillService.getLoadedSkills().map(skill => skill.id)).toEqual(['review']);
        await runtime.dispose();
    });

    it.each(['tool.call', 'skill.load'])('orders UI unload after a pending %s load and its persisted identity', async kind => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await runtime.skillCatalog.saveSkill(skillDefinition());
        const state = sessionState(), ctx = context(state);
        const controls = createSessionSkillControls({ openSession: async () => ({
            getShared: state.get, setShared: (key: string, value: JsonValue, options: { expectedVersion?: number | null }) => state.set(key, value, options.expectedVersion),
        }) } as never, runtime.sessions);
        const scope = await runtime.sessions.restore('session-a', []);
        const original = scope.skillService.loadSkill.bind(scope.skillService);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const loading = vi.spyOn(scope.skillService, 'loadSkill').mockImplementation(async id => { await gate; return original(id); });
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const adapter = effects.find(effect => effect.kind === kind)!;
        const load = adapter.execute(kind === 'tool.call'
            ? { resourceHandleId: 'tool-handle', toolId: 'load_skill', args: { skill_id: 'review' } }
            : { resourceHandleId: 'skill-handle', skillId: 'review' }, ctx);
        await vi.waitFor(() => expect(loading).toHaveBeenCalled());
        const unload = controls.unload('session-a', 'review');
        release(); await load; await unload;
        expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        expect(scope.skillService.getLoadedSkills()).toEqual([]);
        await runtime.disposeSession('session-a');
        expect((await runtime.sessions.restore('session-a', (await state.get('kernel-adapters.skills.loaded'))?.value)).skillService.getLoadedSkills()).toEqual([]);
        await runtime.dispose();
    });

    it('invalidates queued UI operations on scope disposal without resurrecting the old Session scope', async () => {
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        const state = sessionState();
        await state.set('kernel-adapters.skills.loaded', ['review'], null);
        const controls = createSessionSkillControls({ openSession: async () => ({
            getShared: state.get, setShared: (key: string, value: JsonValue, options: { expectedVersion?: number | null }) => state.set(key, value, options.expectedVersion),
        }) } as never, runtime.sessions);
        await runtime.sessions.get('session-a');
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started = false;
        const active = runSessionSkillOperation(runtime.sessions, 'session-a', () => { started = true; return gate; });
        await vi.waitFor(() => expect(started).toBe(true));
        const queued = controls.unload('session-a', 'review');
        const rejected = expect(queued).rejects.toThrow('scope changed');
        const closing = runtime.disposeSession('session-a');
        const get = vi.spyOn(runtime.sessions, 'get');
        release(); await active; await rejected; await closing;
        expect(get).not.toHaveBeenCalled();
        expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual(['review']);
        await controls.unload('session-a', 'review');
        expect(parseLoadedSkillIds((await state.get('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        await runtime.dispose();
        await expect(controls.list('session-a')).rejects.toThrow('closed');
    });

    it('delivers declared supporting files through the Session capability and fails without it', async () => {
        const readFile = async (path: string) => {
            const content = new Map([['/workspace/skills/review/ref.md', 'Reference material'],
                ['/workspace/skills/review/template.md', 'Output format'], ['/workspace/corrections.md', 'Past correction']]).get(path);
            if (!content) throw new Error('Not authorized');
            return content;
        };
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
            fileContextForSession: async () => ({ cwd: '/workspace', vfs: { readFile, writeFile: async () => {}, listFiles: async () => [] }, release: async () => {} }) });
        const definition = { ...skillDefinition(), fsRoot: '/workspace/skills/review', scopeRoot: '/workspace',
            referencePaths: ['ref.md'], templatePath: 'template.md', correctionLog: { enabled: true, path: 'corrections.md' } };
        await runtime.skillCatalog.saveSkill(definition);
        const effects: EffectAdapter[] = []; runtime.plugin.install(registration(effects));
        const result = await effects.find(effect => effect.kind === 'tool.call')!.execute({
            resourceHandleId: 'tool-handle', toolId: 'load_skill', args: { skill_id: 'review' },
        }, context(sessionState())) as import('@itookit/tools/contracts').ToolInvokeResult;
        for (const content of ['Reference material', 'Output format', 'Past correction']) expect(result.output).toContain(content);
        await runtime.dispose();
        const unbound = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
        await unbound.skillCatalog.saveSkill(definition);
        expect((await (await unbound.sessions.get('s')).skillService.loadSkill('review')).success).toBe(false);
        await unbound.dispose();
    });

    it('registers TTY tools and effect only when a TTY driver is configured', async () => {
        const tty = { supportsPty: false, spawn() { throw new Error('unused'); } } as ITTYDriver;
        const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver, fileContextForSession: async () => ({
            vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] },
            cwd: '/', ttyDriver: tty, release: async () => {},
        }) });
        const effects: EffectAdapter[] = [];
        runtime.plugin.install(registration(effects));

        expect((await runtime.sessions.get('tty-session')).toolService.getToolMeta('shell_session')).toBeDefined();
        expect(effects.map(effect => effect.kind)).toContain('tty.command');

        await runtime.dispose();
    });
});

function registration(
    effects: EffectAdapter[],
    programs: DurableTaskProgram[] = [],
): KernelRegistration {
    return {
        registerEffect(effect) { effects.push(effect); },
        registerProgram(program) { programs.push(program); },
        registerStorageResolver() {},
        registerWorkspace() {},
    };
}

function skillDefinition(): SkillDefinition {
    return {
        id: 'review', name: 'Review', description: 'Review code', type: 'prompt',
        enabled: true, instructions: 'Review carefully.', tools: [], triggerPatterns: [],
        autoLoad: false, priority: 50,
    };
}

function context(
    sessionState: NonNullable<EffectExecutionContext['sessionState']>,
): EffectExecutionContext {
    return {
        sessionId: 'session-a', taskId: 'task-a', effectId: 'effect-a',
        abortSignal: new AbortController().signal,
        grants: ['skill', 'tool'].map(kind => ({
            handleId: `${kind}-handle`, right: 'execute' as const,
            resource: {
                id: `${kind}-resource`, sessionId: 'session-a', kind, uri: `${kind}://runtime`,
                generation: 1, createdAt: Date.now(),
            },
        })),
        sessionState,
    };
}

function sessionState(): NonNullable<EffectExecutionContext['sessionState']> {
    const values = new Map<string, SharedStateEntry>();
    return {
        async get<T extends JsonValue>(key: string) {
            return values.get(key) as SharedStateEntry<T> | undefined;
        },
        async set<T extends JsonValue>(key: string, value: T, expected?: number | null) {
            const current = values.get(key);
            if ((current?.version ?? null) !== (expected ?? null)) throw new Error('version conflict');
            const entry = { key, value, version: (current?.version ?? 0) + 1, updatedAt: Date.now() };
            values.set(key, entry);
            return entry;
        },
    };
}
