import { expect, it, vi } from 'vitest';
import type { IDeviceDriver } from '@itookit/vfs-core';
import { createKernelAdaptersRuntime } from '../runtime/create-kernel-adapters-runtime';
import { restoreLoadedSkills } from './restore-loaded-skills';

it('rolls back partial restoration, preserves prior selections and permits a corrected retry', async () => {
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver });
    try {
        for (const id of ['prior', 'first', 'last']) await runtime.skillCatalog.saveSkill({
            id, name: id, description: '', type: 'prompt', enabled: true,
            instructions: id, tools: [], triggerPatterns: [], autoLoad: false, priority: 0,
        });
        const service = (await runtime.sessions.get('s')).skillService;
        await service.loadSkill('prior');
        await expect(runtime.sessions.restore('s', ['prior', 'first', 'missing', 'last'])).rejects.toThrow('not found');
        expect(service.getLoadedSkills().map(skill => skill.id)).toEqual(['prior']);
        await runtime.sessions.restore('s', ['prior', 'first', 'last']);
        expect(service.getLoadedSkills().map(skill => skill.id)).toEqual(['prior', 'first', 'last']);
    } finally { await runtime.dispose(); }
});

it('rejects action definitions during durable model-context restoration', async () => {
    const loadSkill = vi.fn();
    await expect(restoreLoadedSkills({ getLoadedSkills: () => [], getSkill: () => ({ triggerStrategy: 'action' }), loadSkill } as never,
        ['action'])).rejects.toThrow('cannot be restored');
    expect(loadSkill).not.toHaveBeenCalled();
});

it('attempts every rollback and retains the original and cleanup failures', async () => {
    const cleanup = new Error('cannot unregister tool');
    const unloadSkill = vi.fn(async (id: string) => { if (id === 'second') throw cleanup; });
    const result = restoreLoadedSkills({ getLoadedSkills: () => [], getSkill: () => ({}), unloadSkill,
        loadSkill: async (id: string) => ({ skillId: id, toolIds: [], success: id !== 'missing', error: 'missing definition' }),
    } as never, ['first', 'second', 'missing']);
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'missing definition' }), cleanup] });
    expect(unloadSkill.mock.calls).toEqual([['second'], ['first']]);
});
