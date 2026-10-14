import { expect, it, vi } from 'vitest';
import { Kernel, KernelError, KernelErrorCode, type EffectExecutionContext } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { rememberLoadedSkill, forgetLoadedSkill } from './loaded-state';

it('merges concurrent successful loads into real Kernel shared records without duplicates', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session/kernel' }) });
    await kernel.initialize();
    try {
        const session = await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
        const state: NonNullable<EffectExecutionContext['sessionState']> = {
            get: key => session.getShared(key),
            set: (key, value, expectedVersion) => session.setShared(key, value, { expectedVersion }),
        };
        await Promise.all([rememberLoadedSkill('one', state), rememberLoadedSkill('two', state)]);
        await rememberLoadedSkill('one', state);
        expect((await session.getShared('kernel-adapters.skills.loaded'))?.value).toEqual(expect.arrayContaining(['one', 'two']));
        expect((await session.getShared('kernel-adapters.skills.loaded'))?.value).toHaveLength(2);
        expect(await session.sharedHistory('kernel-adapters.skills.loaded')).toHaveLength(2);
    } finally { await kernel.dispose(); await manager.dispose(); }
});

it.each([{}, ['review', 7], ['review', ' ']])('rejects malformed loaded state without replacing it: %j', async value => {
    const set = vi.fn();
    const state = { get: async () => ({ value, version: 1 }), set } as never;
    await expect(rememberLoadedSkill('new', state)).rejects.toThrow('Invalid loaded Skill identities');
    await expect(forgetLoadedSkill('review', state)).rejects.toThrow('Invalid loaded Skill identities');
    expect(set).not.toHaveBeenCalled();
});

it.each([
    ['load', 'before'], ['load', 'after'], ['unload', 'before'], ['unload', 'after'],
] as const)('reports %s identity failures %s commit without hiding uncertain results', async (action, phase) => {
    let value = action === 'load' ? [] : ['review'];
    const failure = new Error('storage result unavailable');
    const set = vi.fn(async (_key: string, next: unknown) => {
        if (phase === 'after') value = next as string[];
        throw failure;
    });
    const state = { get: async () => ({ value, version: 1 }), set } as never;
    const mutate = action === 'load' ? rememberLoadedSkill : forgetLoadedSkill;
    await expect(mutate('review', state)).rejects.toBe(failure);
    expect(set).toHaveBeenCalledOnce();
    expect(value.includes('review')).toBe((action === 'load') === (phase === 'after'));
});

it('bounds retries for persistent identity CAS conflicts', async () => {
    const failure = new KernelError(KernelErrorCode.CONFLICT, 'concurrent writer');
    const set = vi.fn(async () => { throw failure; });
    const state = { get: async () => ({ value: [], version: 1 }), set } as never;
    await expect(rememberLoadedSkill('review', state)).rejects.toBe(failure);
    expect(set).toHaveBeenCalledTimes(3);
});
