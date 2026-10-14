import { expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@itookit/tools/contracts';
import { SkillDeviceDriver } from './skill-device-driver';
import { buildSkillPromptContext } from './prompt-context';

function skill(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
    return { id, name: id, description: `${id} metadata`, type: 'prompt', enabled: true,
        instructions: `${id} private body`, tools: [], triggerPatterns: [], autoLoad: false, priority: 0, ...extra };
}

it('includes only metadata for unloaded Skills and full content for explicitly loaded Skills', async () => {
    const service = new SkillDeviceDriver({ registry: new Map([
        ['indexed', skill('indexed')], ['loaded', skill('loaded', { fsRoot: '/workspace', referencePaths: ['ref.md'],
            compact: { marker: 'Compact Instructions', rawContent: 'keep checks', redLines: ['keep checks'] } })],
        ['silent', skill('silent', { disableModelInvocation: true })], ['disabled', skill('disabled', { enabled: false })],
    ]), readFile: async () => 'reference content' });
    await service.loadSkill('loaded');
    await service.loadSkill('silent');
    const result = await buildSkillPromptContext(service);
    expect(result.skillIndex).toContain('indexed metadata');
    expect(result.skillIndex).not.toContain('private body');
    expect(result.skillIndex).not.toContain('loaded');
    expect(result.skillInstructions).toContain('loaded private body');
    expect(result.skillInstructions).toContain('reference content');
    expect(result.skillInstructions).toContain('keep checks');
    expect(JSON.stringify(result)).not.toContain('silent');
    expect(JSON.stringify(result)).not.toContain('disabled');
});

it('propagates supporting-file failure instead of publishing a partial new-run context', async () => {
    let revoked = false;
    const service = new SkillDeviceDriver({ registry: new Map([['review', skill('review', {
        fsRoot: '/workspace', referencePaths: ['ref.md'],
    })]]), readFile: async () => { if (revoked) throw new Error('revoked'); return 'reference'; } });
    await service.loadSkill('review');
    revoked = true;
    await expect(buildSkillPromptContext(service)).rejects.toThrow('revoked');
});

it('loads automatic and matched reference Skills in priority order without activating action or silent Skills', async () => {
    const definitions = [
        skill('core', { autoLoad: true, priority: 1 }),
        skill('matched', { triggerPatterns: ['[', 'review'], priority: 2 }),
        skill('duplicate', { description: 'alpha alpha' }),
        skill('action', { triggerStrategy: 'action', autoLoad: true, triggerPatterns: ['review'] }),
        skill('silent', { disableModelInvocation: true, autoLoad: true }),
    ];
    const service = new SkillDeviceDriver({ registry: new Map(definitions.map(skill => [skill.id, skill])) });
    const saved: string[] = [];
    const result = await buildSkillPromptContext(service, { userMessage: 'review alpha', onAutoLoaded: async id => { saved.push(id); } });
    expect(saved).toEqual(['core', 'matched']);
    expect(result.skillInstructions).toContain('matched private body');
    expect(result.skillInstructions).not.toContain('action private body');
    expect(result.skillIndex).toContain('duplicate');
    expect(result.skillIndex).toContain('action');
    expect(JSON.stringify(result)).not.toContain('silent');
    await buildSkillPromptContext(service, { userMessage: 'review alpha', onAutoLoaded: async id => { saved.push(id); } });
    expect(saved).toEqual(['core', 'matched']);
});

it('unloads a newly matched Skill when loaded identity persistence fails', async () => {
    const service = new SkillDeviceDriver({ registry: new Map([['review', skill('review', { triggerPatterns: ['review'] })]]) });
    await expect(buildSkillPromptContext(service, { userMessage: 'review', onAutoLoaded: async () => { throw new Error('state unavailable'); } }))
        .rejects.toThrow('state unavailable');
    expect(service.getLoadedSkills()).toEqual([]);
});

it('retains both identity and cleanup failures when automatic loading rolls back', async () => {
    const service = new SkillDeviceDriver({ registry: new Map([['review', skill('review', { autoLoad: true })]]) });
    const persistence = new Error('identity storage unavailable');
    const cleanup = new Error('tool cleanup unavailable');
    const unload = vi.spyOn(service, 'unloadSkill').mockRejectedValue(cleanup);
    const result = buildSkillPromptContext(service, { userMessage: 'hello', onAutoLoaded: async () => { throw persistence; } });
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [persistence, cleanup] });
    expect(unload).toHaveBeenCalledWith('review');
});
