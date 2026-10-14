import { expect, it, vi } from 'vitest';
import { createSessionSkillControls } from './session-skill-controls';

it('lists persisted missing identities and unloads only the chosen Session', async () => {
    const records = new Map([['a', ['removed', 'review']], ['b', ['review']]]);
    const unload = vi.fn();
    const kernel = { openSession: async (id: string) => ({
        getShared: async () => ({ value: records.get(id), version: 1 }),
        setShared: async (_key: string, value: string[], options: unknown) => {
            expect(options).toEqual({ expectedVersion: 1 }); records.set(id, value);
        },
    }) };
    const registry = { get: async (id: string) => ({ skillService: {
        getLoadedSkills: () => [], getSkill: (skill: string) => skill === 'review'
            ? { name: 'Review', description: 'Review changes', enabled: true, tools: [] } : undefined,
        unloadSkill: async (skill: string) => { expect(records.get(id)).not.toContain(skill); unload(id, skill); },
    } }) };
    const controls = createSessionSkillControls(kernel as never, registry as never);
    expect(await controls.listLoaded('a')).toMatchObject([
        { id: 'removed', name: 'removed', description: '', loaded: true, enabled: false, definitionEnabled: false, toolCount: 0, unversioned: true },
        { id: 'review', name: 'Review', description: 'Review changes', loaded: true, enabled: true, definitionEnabled: true, toolCount: 0, unversioned: true },
    ]);
    await controls.unload('a', 'removed');
    expect(unload).toHaveBeenCalledWith('a', 'removed');
    expect(records.get('b')).toEqual(['review']);
});

it('does not obtain or change the live scope when persistence fails', async () => {
    const get = vi.fn();
    const controls = createSessionSkillControls({ openSession: async () => ({
        getShared: async () => ({ value: ['review'], version: 1 }),
        setShared: async () => { throw new Error('write failed'); },
    }) } as never, { get } as never);
    await expect(controls.unload('a', 'review')).rejects.toThrow('write failed');
    expect(get).not.toHaveBeenCalled();
});

it.each([false, true])('rolls back only newly activated Skills on load persistence failure (already loaded: %s)', async alreadyLoaded => {
    const skill = { id: 'review', name: 'Review', enabled: true, type: 'prompt', tools: [] };
    const unloadSkill = vi.fn();
    const service = { getSkill: () => skill, getLoadedSkills: () => alreadyLoaded ? [skill] : [],
        loadSkill: async () => ({ success: true, toolIds: ['inspect'] }), unloadSkill };
    const controls = createSessionSkillControls({ openSession: async () => ({
        getShared: async () => undefined, setShared: async () => { throw new Error('write failed'); },
    }) } as never, { get: async () => ({ skillService: service }) } as never);
    await expect(controls.load('session', 'review')).rejects.toThrow('write failed');
    expect(unloadSkill).toHaveBeenCalledTimes(alreadyLoaded ? 0 : 1);
});

it('lists available skills and serializes a rapid load followed by unload', async () => {
    const skill = { id: 'review', name: 'Review', description: '', enabled: true, type: 'prompt', tools: [] };
    let ids: string[] = [], live = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const unloadSkill = vi.fn(async () => { live = false; });
    const service = { listSkills: () => [skill], getSkill: () => skill, getLoadedSkills: () => live ? [skill] : [],
        loadSkill: async () => { await pending; live = true; return { success: true, toolIds: ['inspect'] }; }, unloadSkill };
    const controls = createSessionSkillControls({ openSession: async () => ({
        getShared: async () => ({ value: ids, version: 1 }), setShared: async (_key: string, value: string[]) => { ids = value; },
    }) } as never, { get: async () => ({ skillService: service }) } as never);
    expect(await controls.list('session')).toContainEqual(expect.objectContaining({ id: 'review', loaded: false }));
    const load = controls.load('session', 'review');
    const unload = controls.unload('session', 'review');
    await Promise.resolve(); expect(unloadSkill).not.toHaveBeenCalled();
    release(); expect(await load).toEqual(['inspect']); await unload;
    expect(ids).toEqual([]); expect(live).toBe(false);
});

it.each([{ enabled: false }, { disableModelInvocation: true }, { triggerStrategy: 'action' }])('rejects unavailable model-context Skills: %j', async policy => {
    const loadSkill = vi.fn();
    const service = { getSkill: () => ({ enabled: true, type: 'prompt', ...policy }), loadSkill };
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => undefined }) } as never,
        { get: async () => ({ skillService: service }) } as never);
    await expect(controls.load('session', 'review')).rejects.toThrow('cannot be loaded');
    expect(loadSkill).not.toHaveBeenCalled();
});

it('describes a Skill definition for explicit invocation without loading it', async () => {
    const loadSkill = vi.fn();
    const definition = { name: 'Review', type: 'prompt', instructions: 'Do it.', triggerStrategy: 'action' as const,
        disableModelInvocation: false, enabled: true, tools: [] };
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => undefined }) } as never,
        { get: async () => ({ skillService: { getSkill: (id: string) => id === 'review' ? definition : undefined, loadSkill } }) } as never);

    expect(await controls.describe('session', 'review')).toEqual({ name: 'Review', type: 'prompt',
        instructions: 'Do it.', triggerStrategy: 'action', disableModelInvocation: false, enabled: true });
    expect(await controls.describe('session', 'missing')).toBeUndefined();
    expect(loadSkill).not.toHaveBeenCalled();
});

it('mounts and unmounts editor targets through the Session scope in order', async () => {
    const calls: string[] = [];
    const service = { mountByGlob: (path: string) => { calls.push(`mount ${path}`); },
        unmountByGlob: (path: string) => { calls.push(`unmount ${path}`); } };
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => undefined }) } as never,
        { get: async () => ({
            skillService: { ...service, getLoadedSkills: () => [], listSkills: () => [],
                getSkill: () => undefined, loadSkill: async () => ({ success: true, toolIds: [] }),
                unloadSkill: async () => {} } }) } as never);
    await controls.mountByGlob('session', '/s/files/workspace/src/app.ts');
    await controls.unmountByGlob('session', '/s/files/workspace/src/app.ts');
    expect(calls).toEqual(['mount /s/files/workspace/src/app.ts', 'unmount /s/files/workspace/src/app.ts']);
    await expect(controls.mountByGlob('session', '  ')).rejects.toThrow('file path');
    await expect(controls.unmountByGlob('session', '')).rejects.toThrow('file path');
    expect(calls).toHaveLength(2);
});

it('forwards change subscriptions to the live Session scope and rejects a missing listener', async () => {
    const listener = () => {};
    const detach = () => {};
    const onChange = vi.fn(() => detach);
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => undefined }) } as never,
        { get: async () => ({ skillService: { onChange } }) } as never);
    expect(await controls.onChange('session', listener)).toBe(detach);
    expect(onChange).toHaveBeenCalledWith(listener);
    await expect(controls.onChange('session', undefined as never)).rejects.toThrow('listener');
    expect(onChange).toHaveBeenCalledTimes(1);
});
