import { expect, it, vi } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend, type IDeviceDriver } from '@itookit/vfs-core';
import type { SkillDefinition, SkillVersionPolicy } from '@itookit/tools/contracts';
import { createKernelAdaptersRuntime } from '../runtime/create-kernel-adapters-runtime';
import { createSessionSkillControls } from './session-skill-controls';
import { resolveSessionSkillContext, resolveSessionSelectedSkills } from './session-prompt-context';
import { parseLoadedSkillVersions, requireLoadedSkillVersions } from './loaded-state';
import { SkillDeviceDriver } from './skill-device-driver';
import { createSkillVersionSnapshot, validateSkillVersionSnapshot } from './version-snapshot';

const definition = (versionPolicy: SkillVersionPolicy = 'require-reload'): SkillDefinition => ({
    id: 'review', name: 'Review', description: '', enabled: true, type: 'prompt', autoLoad: false,
    instructions: 'old instructions', priority: 0, triggerPatterns: ['review'], tools: [], versionPolicy,
    fsRoot: '/workspace/skill', referencePaths: ['reference.md'],
});

it.each(['keep-old', 'require-reload'] as const)('persists %s versions and drift through scope reconstruction and explicit reload', async policy => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/module/versions');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver({ kind: 'test', resolve: async () => ({ fs, rootPath: '/session/kernel' }) });
    await kernel.initialize();
    const session = await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
    let current = definition(policy), reference = 'old reference';
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as IDeviceDriver,
        fileContextForSession: async () => ({ cwd: '/workspace', release: async () => {},
            vfs: { readFile: async () => reference, writeFile: async () => {}, listFiles: async () => [] } }),
        skillSourceForSession: () => ({ loadScope: async cwd => ({ cwd, skills: [current], agentInstructions: '' }) }),
    });
    const record = async () => parseLoadedSkillVersions((await session.getShared('kernel-adapters.skills.loaded'))?.value)!;
    try {
        await resolveSessionSkillContext(kernel, runtime.sessions, 's', 'review');
        const before = (await record()).snapshots.review;
        expect(before.instructions).toContain('old reference');
        await runtime.disposeSession('s');
        current = { ...current, instructions: 'new instructions' }; reference = 'new reference';
        const next = resolveSessionSkillContext(kernel, runtime.sessions, 's', 'unrelated');
        if (policy === 'keep-old') {
            const context = await next;
            expect(context.skillInstructions).toContain('old instructions');
            expect(context.skillInstructions).toContain('old reference');
            expect(context.skillInstructions).not.toContain('new reference');
            const selected = await resolveSessionSelectedSkills(kernel, runtime.sessions, 's', ['review']);
            expect(selected[0].instructions).toContain('old reference');
            expect(selected[0].instructions).not.toContain('new instructions');
        } else await expect(next).rejects.toThrow('reload required');
        if (policy === 'require-reload') await expect(resolveSessionSelectedSkills(kernel, runtime.sessions, 's', ['review'])).rejects.toThrow('reload required');
        const drifted = await record();
        expect(drifted.snapshots.review).toEqual(before);
        expect(drifted.drifts.review).toMatchObject({ expectedDigest: before.digest, policy });
        expect(drifted.drifts.review.observedDigest).not.toBe(before.digest);
        const controls = createSessionSkillControls(kernel, runtime.sessions);
        expect((await controls.list('s'))[0].drift).toEqual(drifted.drifts.review);
        await controls.load('s', 'review');
        expect((await record()).drifts).toEqual({});
        expect((await record()).snapshots.review.digest).not.toBe(before.digest);
        await runtime.disposeSession('s');
        expect((await resolveSessionSkillContext(kernel, runtime.sessions, 's', 'unrelated')).skillInstructions).toContain('new reference');
        await controls.unload('s', 'review');
        expect((await record()).snapshots).toEqual({});
    } finally { await runtime.dispose(); await kernel.dispose(); await manager.dispose(); }
});

it('rejects corrupted versions and treats definition key order and timestamps consistently', () => {
    const original = definition();
    const snapshot = createSkillVersionSnapshot(original, 'body', 'rules');
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as SkillDefinition;
    expect(createSkillVersionSnapshot({ ...reordered, modifiedAt: 3 }, 'body', 'rules').digest).toBe(snapshot.digest);
    expect(() => validateSkillVersionSnapshot({ ...snapshot, instructions: 'corrupt' })).toThrow('Invalid loaded');
    expect(createSkillVersionSnapshot(original, 'changed support', 'rules').digest).not.toBe(snapshot.digest);
});

it('requires explicit reload for legacy identities instead of inventing their previous contents', () => {
    expect(() => requireLoadedSkillVersions(['review'])).toThrow('reload required');
    expect(() => requireLoadedSkillVersions({ format: 2, ids: ['review'], snapshots: {}, drifts: {} })).toThrow('reload required');
    expect(() => requireLoadedSkillVersions([])).not.toThrow();
});

it('restores the previous keep-old selection when explicit reload cannot persist', async () => {
    const registry = new Map([['review', { ...definition('keep-old'), referencePaths: [] }]]);
    const service = new SkillDeviceDriver({ registry });
    const previous = (await service.loadSkill('review')).snapshot!;
    const saved = { format: 2, ids: ['review'], snapshots: { review: previous }, drifts: {} };
    registry.set('review', { ...registry.get('review')!, instructions: 'new instructions' });
    const setShared = vi.fn(async () => { throw new Error('disk unavailable'); });
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => ({ value: saved, version: 1 }), setShared }) } as never,
        { get: async () => ({ skillService: service }) } as never);
    await expect(controls.load('s', 'review')).rejects.toThrow('disk unavailable');
    expect(service.getSkillSnapshot('review')).toEqual(previous);
    expect((await service.loadSkill('review')).instructions).toBe('old instructions');
    expect(setShared).toHaveBeenCalledOnce();
});

it.each(['source', 'tool', 'disabled'] as const)('does not let keep-old preserve revoked %s authority', async change => {
    const original = { ...definition('keep-old'), referencePaths: [] };
    const registry = new Map([['review', original]]);
    const service = new SkillDeviceDriver({ registry });
    await service.loadSkill('review');
    registry.set('review', { ...original, ...(change === 'source' ? { fsRoot: '/other' }
        : change === 'disabled' ? { enabled: false } : { tools: [{ toolId: 'new', executionType: 'http' as const, definition: { name: 'new' } }] }) });
    await expect(service.validateLoadedVersions()).rejects.toThrow(/reload required|disabled/);
    expect(service.getLoadedSkills()).toEqual([]);
});
