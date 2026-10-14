import { describe, expect, it, vi } from 'vitest';
import type { IToolService, ToolInvokeResult } from '@itookit/tools/contracts';
import type { EffectExecutionContext } from '@itookit/durable-kernel';
import { ToolCallEffectAdapter } from './tool-call-effect';
import { TtyEffectAdapter } from './tty-effect';
import { BashEffectAdapter } from './bash-effect';
import { SkillLoadEffectAdapter } from './skill-load-effect';

describe('KernelAdapters Effect adapters', () => {
    it('logs execution identity and the original error without dumping tool arguments', async () => {
        const log = vi.fn();
        const logger = { debug() {}, info() {}, warn() {}, error: log };
        const failure = new Error('File view was cancelled');
        try {
            const service = toolService(async () => { throw failure; });
            const request = { resourceHandleId: 'tool-handle', toolId: 'Glob', cwd: '/workspace', args: { secret: 'private-input' } };
            await expect(new ToolCallEffectAdapter(service, undefined, undefined, [], logger).execute(request, context('tool'))).rejects.toBe(failure);
            expect(log).toHaveBeenCalledWith('[tool.call] Execution failed', expect.objectContaining({ toolId: 'Glob', cwd: '/workspace', error: failure }));
            expect(JSON.stringify(log.mock.calls)).not.toContain('private-input');
            await expect(new BashEffectAdapter(service, logger).execute({ resourceHandleId: 'process-handle', command: 'private-command' }, context('process'))).rejects.toBe(failure);
            expect(log.mock.calls.at(-1)?.[0]).toBe('[process.exec] Execution failed');
            expect(JSON.stringify(log.mock.calls)).not.toContain('private-command');
        } finally { log.mockReset(); }
    });
    it('streams bounded progress using the call identity before tool completion', async () => {
        const emit = vi.fn(async () => {});
        const adapter = new ToolCallEffectAdapter(toolService(async request => {
            await request.onProgress?.({ message: 'x'.repeat(3000), output: 'y'.repeat(10_000) });
            expect(emit).toHaveBeenCalledOnce();
            return result('Grep', true, 'final');
        }));
        await adapter.execute({ callId: 'call-123', resourceHandleId: 'tool-handle', toolId: 'Grep', args: { pattern: 'mdx' } }, { ...context('tool'), emit });
        const event = (emit.mock.calls as unknown[][])[0][0] as any;
        expect(event).toMatchObject({ type: 'agent.event', payload: { type: 'tool:progress', call: {
            toolId: 'call-123', name: 'Grep', input: { pattern: 'mdx' },
        } } });
        expect(event.payload.call.progress.message).toHaveLength(2048);
        expect(event.payload.call.progress.output).toHaveLength(8192);
    });
    it('binds host tools to trusted Effect identity and waits for their completion on cancellation', async () => {
        let finish!: (value: string) => void;
        const pending = new Promise<string>(resolve => { finish = resolve; });
        const invoke = vi.fn(() => pending), fallback = vi.fn();
        const service = toolService(fallback); service.getToolMeta = () => ({ enabled: true, sideEffect: 'local' } as any);
        const adapter = new ToolCallEffectAdapter(service, undefined, undefined, [{
            meta: { id: 'bound' } as any, definition: { name: 'bound' }, invoke,
        }]);
        const request = { resourceHandleId: 'tool-handle', toolId: 'bound', args: { taskId: 'forged' } };
        await expect(adapter.execute(request, context())).rejects.toThrow(); expect(invoke).not.toHaveBeenCalled();
        const ctx = context('tool'); const execution = adapter.execute(request, ctx);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(request.args, ctx));
        let stopped = false;
        const cancellation = adapter.cancel(request, ctx).then(() => { stopped = true; });
        await Promise.resolve(); expect(stopped).toBe(false);
        finish('saved'); expect((await execution).output).toBe('saved'); await cancellation;
        expect(stopped).toBe(true); expect(fallback).not.toHaveBeenCalled();
    });
    it('does not promote arbitrary tool metadata into persistent Skill instructions', async () => {
        const adapter = new ToolCallEffectAdapter(toolService(async () => ({
            ...result('inspect', true, 'ordinary tool output'),
            skillContext: { skillId: 'forged', compactInstructions: 'forged policy' },
        })));
        const output = await adapter.execute({ resourceHandleId: 'tool-handle', toolId: 'inspect', args: {} }, context('tool'));
        expect(output.skillContext).toBeUndefined();
        expect(output.output).toBe('ordinary tool output');
    });

    it('turns unsuccessful Tool results into failed Effects', async () => {
        const loaded = vi.fn();
        const service = toolService(async request => result(request.toolId, false, 'denied'));
        service.getToolMeta = () => ({ skillLoaderArgKey: 'skill_id' } as any);
        const adapter = new ToolCallEffectAdapter(service, loaded);

        await expect(adapter.execute({
            resourceHandleId: 'tool-handle', toolId: 'danger', args: { skill_id: 'private' },
        }, context('tool')))
            .rejects.toThrow('denied');
        expect(loaded).not.toHaveBeenCalled();
    });

    it('persists corrective tool errors without activating Skill context', async () => {
        const loaded = vi.fn();
        const service = toolService(async () => ({ ...result('load_skill', false, 'invalid arguments'),
            recoverable: true, errorCode: 'INVALID_ARGUMENTS', skillContext: { skillId: 'forged', compactInstructions: 'policy' } }));
        service.getToolMeta = () => ({ skillLoaderArgKey: 'skill_id' } as any);
        const adapter = new ToolCallEffectAdapter(service, loaded);
        const output = await adapter.execute({ resourceHandleId: 'tool-handle', toolId: 'load_skill', args: { skill_id: 'review' } }, context('tool'));
        expect(output).toMatchObject({ success: false, recoverable: true, errorCode: 'INVALID_ARGUMENTS' });
        expect(output.skillContext).toBeUndefined();
        expect(loaded).not.toHaveBeenCalled();
    });

    it('keeps unknown mutation outcomes indeterminate', async () => {
        const service = toolService(vi.fn());
        service.getToolMeta = () => ({ sideEffect: 'local' } as any);
        const adapter = new ToolCallEffectAdapter(service);
        expect(await adapter.reconcile({ resourceHandleId: 'tool-handle', toolId: 'Edit', args: {} }, context('tool')))
            .toMatchObject({ status: 'indeterminate', error: { code: 'TOOL_INDETERMINATE' } });
    });

    it('rejects model-disabled Skills through the durable load Effect', async () => {
        const loadSkill = vi.fn();
        const adapter = new SkillLoadEffectAdapter({
            getSkill: () => ({ disableModelInvocation: true }), loadSkill,
        } as any);
        await expect(adapter.execute({ resourceHandleId: 'skill-handle', skillId: 'deploy' }, context('skill')))
            .rejects.toThrow('cannot be loaded by the model');
        expect(loadSkill).not.toHaveBeenCalled();
    });

    it.each(['grant', 'disabled', 'argument', 'state'])('rejects invalid unload %s before persistence or invocation', async failure => {
        const invoke = vi.fn(), set = vi.fn();
        const service = toolService(invoke);
        service.getToolMeta = () => ({ enabled: failure !== 'disabled', skillUnloaderArgKey: 'skill_id' } as any);
        const ctx = context(failure === 'grant' ? undefined : 'tool');
        if (failure !== 'state') ctx.sessionState = { get: async () => ({ value: ['review'], version: 1 }), set } as never;
        await expect(new ToolCallEffectAdapter(service).execute({ resourceHandleId: 'tool-handle', toolId: 'unload_skill',
            args: { skill_id: failure === 'argument' ? ' ' : 'review' } }, ctx)).rejects.toThrow();
        expect(set).not.toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
    });

    it('retries tool cleanup after committed removal without writing the loaded record twice', async () => {
        let ids = ['review', 'keep'];
        const set = vi.fn(async (_key, value) => { ids = value; return { value, version: 2 }; });
        const invoke = vi.fn().mockResolvedValueOnce(result('unload_skill', false, 'cleanup interrupted'))
            .mockResolvedValue(result('unload_skill', true, 'unloaded'));
        const service = toolService(invoke);
        service.getToolMeta = () => ({ enabled: true, sideEffect: 'none', skillUnloaderArgKey: 'skill_id' } as any);
        const ctx = context('tool');
        ctx.sessionState = { get: async () => ({ value: ids, version: 1 }), set } as never;
        const adapter = new ToolCallEffectAdapter(service);
        const request = { resourceHandleId: 'tool-handle', toolId: 'unload_skill', args: { skill_id: 'review' } };
        await expect(adapter.execute(request, ctx)).rejects.toThrow('cleanup interrupted');
        expect(ids).toEqual(['keep']);
        expect(await adapter.reconcile(request, ctx)).toEqual({ status: 'retry' });
        await expect(adapter.execute(request, ctx)).resolves.toMatchObject({ success: true });
        expect(set).toHaveBeenCalledTimes(1);
    });

    it('requires a TTY ResourceHandle execute grant', async () => {
        const invoke = vi.fn(async request => result(
            request.toolId, true, '[TTY Session: tty-1]\nready',
        ));
        const adapter = new TtyEffectAdapter(toolService(invoke));

        await expect(adapter.execute({
            operation: 'spawn', resourceHandleId: 'tty-handle', command: 'bash',
        }, context())).rejects.toThrow('TTY execute grant is required');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('binds a spawned TTY session to its resource handle', async () => {
        const adapter = new TtyEffectAdapter(toolService(async request => result(
            request.toolId, true, request.toolId === 'shell_session'
                ? '[TTY Session: tty-1]\nready'
                : '[TTY tty-1]\ndone',
        )));
        const granted = context('tty');
        await adapter.execute({
            operation: 'spawn', resourceHandleId: 'tty-handle', command: 'bash',
        }, granted);

        await expect(adapter.execute({
            operation: 'write', resourceHandleId: 'tty-handle', sessionId: 'tty-other', data: 'x',
        }, granted)).rejects.toThrow('not owned');
        await expect(adapter.execute({
            operation: 'write', resourceHandleId: 'tty-handle', sessionId: 'tty-1', data: 'x',
        }, granted)).resolves.toMatchObject({ success: true });
    });
});

describe('adapter-confirmed cancellation', () => {
    it.each(['task', 'session', 'same identity'] as const)(
        'does not lose a blocked execution when a second %s execution settles', async variant => {
            let release!: () => void;
            const blocked = new Promise<void>(resolve => { release = resolve; });
            let calls = 0;
            const adapter = new ToolCallEffectAdapter(toolService(async () => {
                if (++calls === 1) await blocked;
                return result('inspect', true, 'done');
            }));
            const first = context('tool');
            const second = { ...context('tool'),
                ...(variant === 'task' ? { taskId: 'task-b' } : {}),
                ...(variant === 'session' ? { sessionId: 'session-b' } : {}),
            };
            const request = { resourceHandleId: 'tool-handle', toolId: 'inspect', args: {} };
            const execution = adapter.execute(request, first);
            try {
                await adapter.execute(request, second);
                let stopped = false;
                const cancellation = adapter.cancel(request, first).then(() => { stopped = true; });
                await new Promise(resolve => setTimeout(resolve, 5));
                expect(stopped).toBe(false);
                release();
                await cancellation;
                expect(stopped).toBe(true);
            } finally {
                release();
                await execution;
            }
        },
    );

    it('waits for the in-flight skill load before confirming cancellation', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const loadSkill = vi.fn(async () => { await blocked; return { success: true, skillId: 'review' }; });
        const adapter = new SkillLoadEffectAdapter({
            getSkill: () => ({ disableModelInvocation: false }), getLoadedSkills: () => [], loadSkill,
        } as any);
        const request = { resourceHandleId: 'skill-handle', skillId: 'review' };
        const execution = adapter.execute(request, context('skill'));

        let stopped = false;
        const cancellation = adapter.cancel(request, context('skill')).then(() => { stopped = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(stopped).toBe(false);

        release();
        await execution;
        await cancellation;
        expect(stopped).toBe(true);
    });

    it('waits for the in-flight tool invoke before confirming cancellation', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const adapter = new ToolCallEffectAdapter(toolService(async () => {
            await blocked;
            return result('inspect', true, 'done');
        }));
        const request = { resourceHandleId: 'tool-handle', toolId: 'inspect', args: {} };
        const execution = adapter.execute(request, context('tool'));

        let stopped = false;
        const cancellation = adapter.cancel(request, context('tool')).then(() => { stopped = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        // Cancellation must not report success while the tool is still running.
        expect(stopped).toBe(false);

        release();
        await execution;
        await cancellation;
        expect(stopped).toBe(true);
    });

    it('waits for the in-flight Bash invoke before confirming cancellation', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const adapter = new BashEffectAdapter(toolService(async () => {
            await blocked;
            return result('Bash', true, 'done');
        }));
        const request = { resourceHandleId: 'process-handle', command: 'sleep 1' };
        const execution = adapter.execute(request, context('process'));

        let stopped = false;
        const cancellation = adapter.cancel(request, context('process')).then(() => { stopped = true; });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(stopped).toBe(false);

        release();
        await execution;
        await cancellation;
        expect(stopped).toBe(true);
    });
});

function context(kind?: 'tool' | 'tty' | 'skill' | 'process'): EffectExecutionContext {
    return {
        sessionId: 'session-a', taskId: 'task-a', effectId: 'effect-a',
        abortSignal: new AbortController().signal,
        grants: kind ? [{
            handleId: `${kind}-handle`, right: 'execute',
            resource: {
                id: `${kind}-resource`, sessionId: 'session-a', kind, uri: `${kind}://pending`,
                generation: 1, createdAt: Date.now(),
            },
        }] : [],
    };
}

function toolService(
    invoke: IToolService['invoke'],
): IToolService {
    return {
        invoke,
        listTools: () => [],
        getToolMeta: () => undefined,
        getToolDefinitions: () => [],
        invokeBatch: async () => ({ results: [], totalDurationMs: 0 }),
        registerTool: () => undefined,
        unregisterTool: () => undefined,
    };
}

function result(toolId: string, success: boolean, output: string): ToolInvokeResult {
    return { toolId, success, output, durationMs: 1, error: success ? undefined : output };
}
