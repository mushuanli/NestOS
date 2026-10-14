import { expect, it, vi } from 'vitest';
import { coordinateSkillEffect, runSessionSkillOperation, invalidateSessionSkillOperations, reopenSessionSkillOperations, closeSessionSkillOperations } from './operation-queue';

it('isolates Sessions and registry instances and releases the queue after a failure', async () => {
    const registry = {} as never, other = {} as never;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = runSessionSkillOperation(registry, 'a', async () => { await gate; throw new Error('failed'); });
    const failure = expect(first).rejects.toThrow('failed');
    const next = vi.fn(async () => 'next');
    const pending = runSessionSkillOperation(registry, 'a', next);
    expect(await runSessionSkillOperation(registry, 'b', async () => 'b')).toBe('b');
    expect(await runSessionSkillOperation(other, 'a', async () => 'other')).toBe('other');
    expect(next).not.toHaveBeenCalled();
    release(); await failure; expect(await pending).toBe('next');
});

it('preserves adapter recovery and cancellation contracts', async () => {
    const effect = { kind: 'test', version: '1', recoveryPolicy: 'manual' as const,
        execute: vi.fn(async () => 'done'), cancel: vi.fn(async () => {}), reconcile: vi.fn(async () => ({ status: 'retry' as const })) };
    const wrapped = coordinateSkillEffect(effect, {} as never), context = {} as never;
    expect(wrapped.recoveryPolicy).toBe('manual');
    await wrapped.cancel!('request', context); await wrapped.reconcile!('request', context);
    expect(effect.cancel).toHaveBeenCalledWith('request', context);
    expect(effect.reconcile).toHaveBeenCalledWith('request', context);
});

it.each(['execute', 'reconcile'] as const)('checks grants before resolving a tool scope during %s', async method => {
    const get = vi.fn();
    const effect = { kind: 'tool.call', version: '1', execute: vi.fn(), reconcile: vi.fn() };
    const wrapped = coordinateSkillEffect(effect, { get } as never);
    await expect(wrapped[method]!({ resourceHandleId: 'tool', toolId: 'load_skill' }, {
        sessionId: 'a', grants: [], abortSignal: new AbortController().signal,
    } as never)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(effect[method]).not.toHaveBeenCalled();
});

it('does not execute a Skill mutation cancelled while waiting behind another operation', async () => {
    const registry = {} as never;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = runSessionSkillOperation(registry, 'a', () => gate);
    const execute = vi.fn();
    const wrapped = coordinateSkillEffect({ kind: 'skill.load', version: '1', execute }, registry);
    const controller = new AbortController();
    const queued = wrapped.execute({}, { sessionId: 'a', abortSignal: controller.signal } as never);
    const rejected = expect(queued).rejects.toThrow();
    controller.abort(); release(); await first; await rejected;
    expect(execute).not.toHaveBeenCalled();
    expect(await runSessionSkillOperation(registry, 'a', async () => 'next')).toBe('next');
});

it('rejects operations during close and does not let an old queue affect its replacement', async () => {
    const registry = {} as never;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    const active = runSessionSkillOperation(registry, 'a', () => { started = true; return gate; });
    await vi.waitFor(() => expect(started).toBe(true));
    invalidateSessionSkillOperations(registry, 'a');
    await expect(runSessionSkillOperation(registry, 'a', async () => 'closed')).rejects.toThrow('scope changed');
    reopenSessionSkillOperations(registry, 'a');
    expect(await runSessionSkillOperation(registry, 'a', async () => 'new')).toBe('new');
    release(); await active;
    closeSessionSkillOperations(registry);
    await expect(runSessionSkillOperation(registry, 'b', async () => 'closed')).rejects.toThrow('closed');
});
