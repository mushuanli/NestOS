import { expect, it } from 'vitest';
import { TauriSkillSource } from '../../../apps/tauri-app/src/kernel/tauri-skill-source';

it('keeps correction logs relative to the project root for nested Skill scopes', async () => {
    const source = new TauriSkillSource({
        listFiles: async () => ['/project/nested/_agent/skills/review/SKILL.md'],
        readFile: async () => '---\nname: Review\nreferences: [ref.md]\ntemplate: template.md\nsubagent: {role: reviewer, model: child-model}\ncorrection-log: docs/corrections.md\n---\nReview changes.',
    } as never, '/project');
    const [skill] = await source.loadDirectory('/project/nested/_agent/skills', 'local-fs', '/project/nested');
    expect(skill.correctionLog).toEqual({ path: 'docs/corrections.md', root: '/project', enabled: true });
    expect(skill.referencePaths).toEqual(['ref.md']);
    expect(skill.templatePath).toBe('template.md');
    expect(skill.subagentModel).toBe('child-model');
    expect(skill.fsRoot).toBe('/project/nested/_agent/skills/review');
});

it('discovers and loads supporting files only through each Session view, then rebuilds after replacement', async () => {
    const { createVFS, MemoryBackend } = await import('@itookit/vfs-core');
    const { createKernelAdaptersRuntime } = await import('@itookit/kernel-adapters');
    const { createVFSToolContext } = await import('@itookit/app-core');
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    const first = await manager.openFileSystem('/module/first');
    const second = await manager.openFileSystem('/module/second');
    const roots = new Map([['a', first], ['b', second]]);
    for (const [label, fs] of [['first', first], ['second', second]] as const) {
        await fs.driver.createFile({ name: 'AGENT.md', parentPath: '/workspace/_agent', recursive: true, content: `${label} project rules` });
        await fs.driver.createFile({ name: 'SKILL.md', parentPath: '/workspace/_agent/skills/review', recursive: true,
            content: `---\nname: Review\nreferences: [ref.md]\n---\n${label} review` });
        await fs.driver.createFile({ name: 'ref.md', parentPath: '/workspace/_agent/skills/review', content: `${label} reference` });
    }
    const runtime = await createKernelAdaptersRuntime({ llmDriver: {} as never,
        fileContextForSession: async id => ({ cwd: '/workspace',
            vfs: createVFSToolContext({ fs: roots.get(id)!, cwd: '/workspace', sessionId: id }), release: async () => {} }),
        skillSourceForSession: files => new TauriSkillSource(files.vfs, files.cwd),
    });
    try {
        const a = await runtime.sessions.get('a'), b = await runtime.sessions.get('b');
        expect(a.skillService.getAgentMdContent()).toBe('first project rules');
        expect(b.skillService.getAgentMdContent()).toBe('second project rules');
        const original = await a.skillService.loadSkill('review');
        expect(original.instructions).toContain('first reference');
        expect((await b.skillService.loadSkill('review')).instructions).toContain('second reference');
        expect(a.skillService.getSkill('review')?.fsRoot).toBe('/workspace/_agent/skills/review');
        await first.driver.writeContent('/workspace/_agent/skills/review/ref.md', 'edited reference');
        await first.driver.writeContent('/workspace/_agent/AGENT.md', 'edited project rules');
        const refreshed = await a.skillService.refreshScopedSkills();
        expect(refreshed[0]).toMatchObject({ success: false, error: expect.stringContaining('reload required') });
        expect((await a.skillService.reloadSkill!('review')).instructions).toContain('edited reference');
        expect(a.skillService.getLoadedSkills().map(skill => skill.id)).toEqual(['review']);
        expect(a.skillService.getAgentMdContent()).toBe('edited project rules');
        expect(original.instructions).toContain('first reference');
        roots.set('a', second);
        await runtime.disposeSession('a');
        const replacement = await runtime.sessions.get('a');
        expect(replacement).not.toBe(a);
        expect(replacement.skillService.getAgentMdContent()).toBe('second project rules');
        expect((await replacement.skillService.loadSkill('review')).instructions).toContain('second reference');
        await replacement.skillService.setCwd('/outside');
        expect(replacement.skillService.getSkill('review')).toBeUndefined();
    } finally { await runtime.dispose(); await manager.dispose(); }
});

it('honors an explicit auto-load override and anchors project rules to the project root', async () => {
    const files: Record<string, string> = {
        '/project/_agent/AGENT.md': 'root rules',
        '/project/nested/_agent/AGENT.md': 'nested rules',
        '/project/_agent/skills/review/SKILL.md': '---\nname: Review\nauto-load: false\n---\nReview body',
        '/project/nested/_agent/skills/local/SKILL.md': '---\nname: Local\n---\nLocal body',
    };
    const source = new TauriSkillSource({
        listFiles: async (dir: string) => Object.keys(files).filter(path => path.startsWith(`${dir.replace(/\/+$/, '')}/`)),
        readFile: async (path: string) => files[path] ?? '',
    } as never, '/project');
    const scope = await source.loadScope('/project/nested');
    // A nested `_agent/AGENT.md` is not merged or substituted for the project-root rules.
    expect(scope.agentInstructions).toBe('root rules');
    expect(scope.skills.map(skill => `${skill.id}:${skill.scopeLevel}`).sort())
        .toEqual(['local:local-fs', 'review:global-fs']);
    expect(scope.skills.find(skill => skill.id === 'review')).toMatchObject({ autoLoad: false, triggerStrategy: 'reference' });
});

it('tolerates missing skill directories but propagates revoked access', async () => {
    const absent = new TauriSkillSource({ listFiles: async () => { throw { code: 'ENOENT' }; },
        readFile: async () => { throw { code: 'ENOENT' }; } }, '/workspace');
    expect(await absent.loadScope('/workspace')).toEqual({ cwd: '/workspace', skills: [], agentInstructions: '' });
    const denied = new TauriSkillSource({ listFiles: async () => { throw { code: 'EACCES' }; },
        readFile: async () => '' }, '/workspace');
    await expect(denied.loadScope('/workspace')).rejects.toMatchObject({ code: 'EACCES' });
});
