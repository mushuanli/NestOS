import { parseLoadedSkillIds } from './loaded-state';
// @file: kernel-adapters/src/skill/session-skill-restore.test.ts
// P0-00 reopen semantics: a persisted loaded Skill identity survives a scope rebuild (a new
// host or a new run in the same Session) and its content is re-injected even when the user
// message no longer matches. An explicit unload is not resurrected by that restore.
import { expect, it } from 'vitest';
import type { IDeviceDriver } from '@itookit/vfs-core';
import type { SkillDefinition } from '@itookit/tools/contracts';
import { Kernel } from '@itookit/durable-kernel';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { createKernelAdaptersRuntime } from '../runtime/create-kernel-adapters-runtime';
import { resolveSessionSkillContext } from './session-prompt-context';
import { createSessionSkillControls } from './session-skill-controls';
import { SessionFileSkillSource } from './session-file-source';

/** Reference strategy is off, so only the trigger pattern or a persisted identity loads it. */
const review: SkillDefinition = {
    id: 'review', name: 'Review', description: 'Review changes', type: 'prompt', enabled: true,
    instructions: 'Check every changed interface.', tools: [], triggerPatterns: ['review'],
    autoLoad: false, priority: 10, triggerStrategy: 'reference', source: 'filesystem',
    scopeLevel: 'vfs', globs: [], compact: { rawText: '## Compact Instructions\n- [红线] Preserve access checks.',
        rawContent: '## Compact Instructions\n- [红线] Preserve access checks.', redLines: ['Preserve access checks.'] },
};

function runtimeOptions() {
    return { llmDriver: {} as IDeviceDriver,
        // The per-Session source only exists when the Session has a file context with a cwd.
        fileContextForSession: async () => ({ cwd: '/workspace', release: async () => {},
            vfs: { readFile: async () => '', writeFile: async () => {}, listFiles: async () => [] } }),
        skillSourceForSession: () => ({ loadScope: async () => ({ cwd: '/workspace',
            agentInstructions: 'Always cite the interface contract.', skills: [review] }) }) };
}

it('restores a persisted Skill identity after a scope rebuild and respects unload', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const fs = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs } });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/session/kernel' }; } });
    await kernel.initialize();
    await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: null } });
    const runtimes: Array<Awaited<ReturnType<typeof createKernelAdaptersRuntime>>> = [];
    const build = async () => {
        const runtime = await createKernelAdaptersRuntime(runtimeOptions());
        runtimes.push(runtime);
        return runtime;
    };
    try {
        // First run: the trigger pattern matches, so the Skill loads and its identity persists.
        const first = await build();
        const context = await resolveSessionSkillContext(kernel, first.sessions, 'session', 'review the change');
        expect(context.projectInstructions).toContain('Always cite the interface contract.');
        expect(context.skillInstructions).toContain('Check every changed interface.');
        expect(context.skillInstructions).toContain('Preserve access checks.');
        expect(parseLoadedSkillIds((await (await kernel.openSession('session')).getShared('kernel-adapters.skills.loaded'))?.value))
            .toEqual(['review']);

        // Reopened Session / new host: an unrelated message must still restore the identity.
        const second = await build();
        const restored = await resolveSessionSkillContext(kernel, second.sessions, 'session', 'unrelated request');
        expect(restored.skillInstructions).toContain('Check every changed interface.');
        expect(restored.skillInstructions).toContain('Preserve access checks.');

        // Explicit unload removes the persisted identity; a later unrelated run stays clean.
        await createSessionSkillControls(kernel, second.sessions).unload('session', 'review');
        expect(parseLoadedSkillIds((await (await kernel.openSession('session')).getShared('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        const third = await build();
        const afterUnload = await resolveSessionSkillContext(kernel, third.sessions, 'session', 'unrelated request');
        expect(afterUnload.skillInstructions).not.toContain('Check every changed interface.');
        // Matching again is allowed: unload is not a permanent disable.
        const rematched = await resolveSessionSkillContext(kernel, third.sessions, 'session', 'review changes again');
        expect(rematched.skillInstructions).toContain('Check every changed interface.');
    } finally {
        for (const runtime of runtimes) await runtime.dispose();
        await kernel.dispose();
        await manager.dispose();
    }
}, 20_000);

/**
 * Strict P0-00 distinction, driven by the real filesystem source both hosts share: a
 * `trigger-strategy: reference` Skill with `auto-load: false` is loadable and gets a durable
 * identity, but a run that never loaded it must not receive it. That separates "restored from
 * the persisted identity" from "autoLoad" and from "the message matched again".
 */
it('distinguishes persisted-identity restore from autoLoad and rematch for an auto-load:false Skill', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const root = await manager.openFileSystem('/module/test');
    const kernel = new Kernel({ catalog: { fs: root } });
    kernel.registerStorageResolver({ kind: 'test', async resolve(reference) {
        return { fs: root, rootPath: `/session/${String(reference.locator)}` };
    } });
    await kernel.initialize();
    await kernel.createSession({ id: 'session', storage: { kind: 'test', locator: 'session' } });
    await kernel.createSession({ id: 'fresh', storage: { kind: 'test', locator: 'fresh' } });
    const files: Record<string, string> = {
        '/workspace/_agent/AGENT.md': 'Always cite the interface contract.',
        '/workspace/_agent/skills/review/SKILL.md': [
            '---', 'name: Review', 'description: Review changes interface', 'auto-load: false', '---',
            'Check every changed interface.',
            '', '## Compact Instructions', '- [红线] Preserve access checks.',
        ].join('\n'),
    };
    const paths = Object.keys(files);
    const parseFrontmatter = (text: string) => Object.fromEntries(text.split('\n').flatMap(line => {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        return match ? [[match[1]!, match[2] === 'false' ? false : match[2]!]] : [];
    }));
    const runtimeOptions = () => ({ llmDriver: {} as IDeviceDriver,
        fileContextForSession: async () => ({ cwd: '/workspace', release: async () => {}, vfs: {
            readFile: async (path: string) => {
                const content = files[path];
                if (content === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
                return content;
            },
            writeFile: async () => { throw new Error('read-only fixture'); },
            listFiles: async (dir = '/') => paths.filter(path => path.startsWith(`${dir.replace(/\/+$/, '')}/`)),
        } }),
        skillSourceForSession: (context: { vfs: never; cwd: string }) =>
            new SessionFileSkillSource(context.vfs, context.cwd, parseFrontmatter) });
    const runtimes: Array<Awaited<ReturnType<typeof createKernelAdaptersRuntime>>> = [];
    const build = async () => {
        const runtime = await createKernelAdaptersRuntime(runtimeOptions());
        runtimes.push(runtime);
        return runtime;
    };
    try {
        // A session that never loaded the Skill gets nothing for a non-matching message: the
        // definition is a reference Skill, yet autoLoad is off, so no auto-injection.
        const idle = await build();
        const fresh = await resolveSessionSkillContext(kernel, idle.sessions, 'fresh', 'unrelated request');
        expect(fresh.projectInstructions).toContain('Always cite the interface contract.');
        expect(fresh.skillInstructions).not.toContain('Check every changed interface.');

        // Loading it (here through the trigger match) persists the durable identity.
        const first = await build();
        const matched = await resolveSessionSkillContext(kernel, first.sessions, 'session', 'review changes now');
        expect(matched.skillInstructions).toContain('Check every changed interface.');
        expect(matched.skillInstructions).toContain('Preserve access checks.');
        expect(parseLoadedSkillIds((await (await kernel.openSession('session')).getShared('kernel-adapters.skills.loaded'))?.value))
            .toEqual(['review']);

        // A rebuilt scope (reopened Session / new host) with a non-matching message restores it
        // from the persisted identity — not from autoLoad, and not from a trigger match.
        const second = await build();
        const restored = await resolveSessionSkillContext(kernel, second.sessions, 'session', 'unrelated request');
        expect(restored.skillInstructions).toContain('Check every changed interface.');
        expect(restored.skillInstructions).toContain('Preserve access checks.');

        // Unload clears the identity; the next scope must not resurrect it, while a matching
        // message is still allowed to load it again (unload is not a permanent disable).
        await createSessionSkillControls(kernel, second.sessions).unload('session', 'review');
        expect(parseLoadedSkillIds((await (await kernel.openSession('session')).getShared('kernel-adapters.skills.loaded'))?.value)).toEqual([]);
        const third = await build();
        const afterUnload = await resolveSessionSkillContext(kernel, third.sessions, 'session', 'unrelated request');
        expect(afterUnload.skillInstructions).not.toContain('Check every changed interface.');
        const rematched = await resolveSessionSkillContext(kernel, third.sessions, 'session', 'review changes again');
        expect(rematched.skillInstructions).toContain('Check every changed interface.');
    } finally {
        for (const runtime of runtimes) await runtime.dispose();
        await kernel.dispose();
        await manager.dispose();
    }
}, 20_000);
