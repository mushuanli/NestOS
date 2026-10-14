import { describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@itookit/tools/contracts';
import type { SkillScopeSnapshot } from '../ports/capabilities';
import { SkillDeviceDriver } from './skill-device-driver';
import { createSessionSkillControls } from './session-skill-controls';

function skill(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
    return { id, name: id, description: id, type: 'prompt', enabled: true,
        instructions: id, tools: [], triggerPatterns: [], autoLoad: false, priority: 0,
        compact: { marker: 'Compact Instructions', redLines: [id], rawContent: id }, ...extra };
}
function driver(skills: SkillDefinition[]) {
    return new SkillDeviceDriver({ registry: new Map(skills.map(value => [value.id, value])) });
}

describe('Skill scope boundaries', () => {
    it('requires explicit reload for changed filesystem definitions and preserves explicit unload', async () => {
        let version = 'old';
        const definitions = () => [skill('review', { source: 'filesystem', instructions: version,
            tools: [{ toolId: version, executionType: 'http', definition: { name: version } }] })];
        const registerTool = vi.fn(), unregisterTool = vi.fn();
        const service = new SkillDeviceDriver({ source: { loadScope: async cwd => ({ cwd, skills: definitions(), agentInstructions: version }) },
            toolHandlerFactory: { create: () => async () => ({ success: true, output: '' } as never) } });
        service.setToolService({ getToolMeta: () => undefined, registerTool, unregisterTool } as never);
        await service.setCwd('/project');
        await service.loadSkill('review');
        version = 'new';
        expect(await service.refreshScopedSkills()).toMatchObject([{ success: false, error: expect.stringContaining('reload required') }]);
        expect(service.getLoadedSkills()).toEqual([]);
        await service.reloadSkill('review');
        expect(service.getLoadedSkills().map(value => value.instructions)).toEqual(['new']);
        expect(unregisterTool).toHaveBeenCalledWith('old');
        expect(registerTool.mock.calls.at(-1)?.[0].id).toBe('new');
        expect(service.getAgentMdContent()).toBe('new');
        await service.unloadSkill('review');
        await service.refreshScopedSkills();
        expect(service.getLoadedSkills()).toEqual([]);
        await service.loadSkill('review');
        await service.setCwd('/elsewhere');
        expect(service.getLoadedSkills()).toEqual([]);
    });

    it('keeps refreshed skills inactive when reference reads fail or invocation is disabled', async () => {
        let fail = false, silent = false;
        const service = new SkillDeviceDriver({ readFile: async () => { if (fail) throw new Error('revoked'); return 'reference'; },
            source: { loadScope: async cwd => ({ cwd, agentInstructions: '', skills: [skill('review', {
                source: 'filesystem', fsRoot: '/project', referencePaths: ['ref.md'], disableModelInvocation: silent,
            })] }) } });
        await service.setCwd('/project');
        await service.loadSkill('review');
        fail = true;
        expect(await service.refreshScopedSkills()).toMatchObject([{ skillId: 'review', success: false, error: 'revoked' }]);
        expect(service.getLoadedSkills()).toEqual([]);
        fail = false;
        await service.refreshScopedSkills();
        expect(service.getLoadedSkills()).toHaveLength(1);
        silent = true;
        await service.refreshScopedSkills();
        expect(service.getLoadedSkills()).toEqual([]);
    });

    it('does not reinstall a Skill unloaded while refreshed references are in flight', async () => {
        let wait = false, finish!: (value: string) => void, entered!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const service = new SkillDeviceDriver({ readFile: async () => {
            if (!wait) return 'initial';
            entered(); return new Promise<string>(resolve => { finish = resolve; });
        }, source: { loadScope: async cwd => ({ cwd, agentInstructions: '', skills: [skill('review', {
            source: 'filesystem', fsRoot: '/project', referencePaths: ['ref.md'],
        })] }) } });
        await service.setCwd('/project');
        await service.loadSkill('review');
        wait = true;
        const refresh = service.refreshScopedSkills();
        await reading;
        await service.unloadSkill('review');
        finish('late reference');
        await refresh;
        expect(service.getLoadedSkills()).toEqual([]);
        wait = false;
        await service.refreshScopedSkills();
        expect(service.getLoadedSkills()).toEqual([]);
    });

    it.each(['../secret', '/secret', 'file:secret', 'dir\\secret'])('rejects support path %s before reading or activating', async path => {
        const readFile = vi.fn(async () => 'content');
        const service = new SkillDeviceDriver({ readFile, registry: new Map([['review', skill('review', {
            fsRoot: '/workspace/skills/review', referencePaths: ['valid.md', path],
        })]]) });
        expect((await service.loadSkill('review')).success).toBe(false);
        expect(readFile).not.toHaveBeenCalled();
        expect(service.getLoadedSkills()).toEqual([]);
    });

    it('does not activate a Skill when support content is oversized or its scope changes during IO', async () => {
        const definition = skill('review', { fsRoot: '/workspace', scopeRoot: '/workspace', scopeLevel: 'local-fs', referencePaths: ['reference.md'] });
        const huge = new SkillDeviceDriver({ registry: new Map([['review', definition]]), readFile: async () => 'x'.repeat(65537) });
        await huge.setCwd('/workspace');
        expect((await huge.loadSkill('review')).error).toContain('size limit');
        let resolve!: (value: string) => void;
        const service = new SkillDeviceDriver({ registry: new Map([['review', definition]]), readFile: () => new Promise(done => { resolve = done; }) });
        await service.setCwd('/workspace');
        const loading = service.loadSkill('review');
        await service.setCwd('/elsewhere');
        resolve('old contents');
        expect((await loading).success).toBe(false);
        expect(service.getLoadedSkills()).toEqual([]);
    });
    it('handles root and trailing separators without admitting sibling prefixes or missing roots', async () => {
        const service = driver([
            skill('root', { scopeLevel: 'parent-fs', scopeRoot: '/' }),
            skill('parent', { scopeLevel: 'parent-fs', scopeRoot: '/project/' }),
            skill('local', { scopeLevel: 'local-fs', scopeRoot: '/project' }),
            skill('unbound', { scopeLevel: 'local-fs' }),
        ]);
        expect(service.getScopedSkills()).toEqual([]);
        await service.setCwd('/project/');
        expect(service.getScopedSkills().map(s => s.id)).toEqual(['root', 'parent', 'local']);
        await service.setCwd('/project-other');
        expect(service.getScopedSkills().map(s => s.id)).toEqual(['root']);
    });

    it('rejects out-of-scope loads and limits compaction to active model-visible skills', async () => {
        const service = driver([
            skill('local', { scopeLevel: 'local-fs', scopeRoot: '/project' }),
            skill('other', { scopeLevel: 'parent-fs', scopeRoot: '/other' }),
            skill('silent', { disableModelInvocation: true, globs: ['**/*.ts'] }),
            skill('unloaded'),
        ]);
        await service.setCwd('/project');
        expect((await service.loadSkill('other')).success).toBe(false);
        service.mountByGlob('src/test.ts');
        expect(service.getLoadedSkills()).toEqual([]);
        await service.loadSkill('local');
        await service.loadSkill('silent'); // Explicit host invocation remains supported.
        expect(service.getCompactInstructions()).toBe('[local]\n  - local');
        expect(service.getUnloadedSkills().map(s => s.id)).toEqual(['unloaded']);
        await service.setCwd('/project/child');
        expect(service.getCompactInstructions()).toBe('');
        expect(service.getLoadedSkills().map(s => s.id)).toEqual(['silent']);
    });

    it('keeps filesystem definitions local to the Session and preserves the shared catalog', async () => {
        const catalog = new Map([['same', skill('same')]]);
        const source = { loadScope: async (cwd: string) => ({ cwd, agentInstructions: '',
            skills: [skill('same', { source: 'filesystem', instructions: cwd }), skill(cwd, { source: 'filesystem' })] }) };
        const first = new SkillDeviceDriver({ registry: catalog, source });
        const second = new SkillDeviceDriver({ registry: catalog, source });
        await first.setCwd('/one');
        await second.setCwd('/two');
        expect(first.getSkill('same')?.instructions).toBe('/one');
        expect(second.getSkill('same')?.instructions).toBe('/two');
        expect(first.getSkill('/two')).toBeUndefined();
        expect([...catalog.keys()]).toEqual(['same']);
        expect(catalog.get('same')?.instructions).toBe('same');
        await first.setCwd('/three');
        expect(second.getSkill('/two')).toBeDefined();
    });

    it('drops stale scope scans and leaves old definitions revoked while refreshing', async () => {
        const pending = new Map<string, (value: SkillScopeSnapshot) => void>();
        const service = new SkillDeviceDriver({ source: { loadScope: cwd => new Promise(resolve => pending.set(cwd, resolve)) } });
        const old = service.setCwd('/old');
        const current = service.setCwd('/current');
        pending.get('/current')!({ cwd: '/current', agentInstructions: 'current', skills: [skill('current')] });
        await current;
        pending.get('/old')!({ cwd: '/old', agentInstructions: 'old', skills: [skill('old')] });
        await old;
        expect(service.getSkillNames()).toEqual(['current']);
        expect(service.getAgentMdContent()).toBe('current');
        const refresh = service.setCwd('/next');
        expect(service.getSkillNames()).toEqual([]);
        expect(service.getAgentMdContent()).toBe('');
        await service.dispose();
        pending.get('/next')!({ cwd: '/next', agentInstructions: 'late', skills: [skill('late')] });
        await refresh;
        expect(service.getSkillNames()).toEqual([]);
        expect((await service.loadSkill('late')).success).toBe(false);
    });

    it('unregisters loaded tools when leaving their directory scope', async () => {
        const unregisterTool = vi.fn();
        const service = new SkillDeviceDriver({ registry: new Map([['local', skill('local', {
            scopeLevel: 'local-fs', scopeRoot: '/one', tools: [{ toolId: 'local-tool', executionType: 'http',
                definition: { name: 'local-tool', description: '', parameters: { type: 'object', properties: {} } } }],
        })]]), toolHandlerFactory: { create: () => async () => 'ok' } });
        service.setToolService({ getToolMeta: () => undefined, registerTool: vi.fn(), unregisterTool } as any);
        await service.setCwd('/one');
        await service.loadSkill('local');
        await service.setCwd('/two');
        expect(unregisterTool).toHaveBeenCalledWith('local-tool');
        expect(service.getLoadedSkills()).toEqual([]);
    });
});

it('notifies a Session change subscription whenever the live Skill catalog changes', async () => {
    const driver = new SkillDeviceDriver({ registry: new Map([['review', skill('review')]]) });
    const controls = createSessionSkillControls({ openSession: async () => ({ getShared: async () => undefined }) } as never,
        { get: async () => ({ skillService: driver }) } as never);
    const listener = vi.fn();
    const detach = await controls.onChange('session', listener);
    expect(await controls.list('session')).toContainEqual(expect.objectContaining({ id: 'review' }));

    await driver.saveSkill(skill('debug'));
    expect(listener).toHaveBeenCalledTimes(1);
    detach();
    await driver.saveSkill(skill('other'));
    expect(listener).toHaveBeenCalledTimes(1);
});
