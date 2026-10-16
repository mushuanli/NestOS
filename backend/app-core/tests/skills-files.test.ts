import { expect, it, vi } from 'vitest';
import type { LLMSkill } from '@itookit/kernel-adapters/contracts';
import { SkillsEngine } from '../src/configuration/skills-files';

function fixture() {
    const skill: LLMSkill = { id: 'original', name: 'Original', description: '', instructions: 'Keep instructions',
        type: 'prompt', enabled: false, tools: [], triggerPatterns: [], autoLoad: false, priority: 50 };
    const service = { getSkills: async () => [skill], onChange: () => () => {},
        saveSkill: vi.fn(async (_skill: LLMSkill) => {}), deleteSkill: vi.fn(async (_id: string) => {}) };
    return { engine: new SkillsEngine(service as never), service };
}

it('propagates a storage error without retrying creation under a different identity', async () => {
    const { engine, service } = fixture(), failure = new Error('Storage unavailable');
    service.saveSkill.mockRejectedValueOnce(failure);
    await expect(engine.driver.createFile({ parentPath: '/', name: 'fallback.yaml',
        content: JSON.stringify({ id: 'original', name: 'Original' }) })).rejects.toBe(failure);
    expect(service.saveSkill).toHaveBeenCalledOnce();
    expect(service.saveSkill.mock.calls[0][0].id).toBe('original');
});

it.each(['[', '[]', 'enabled: invalid'])('rejects invalid imported Skill content %j without creating a fallback', async content => {
    const { engine, service } = fixture();
    await expect(engine.driver.createFile({ parentPath: '/', name: 'draft.yaml', content })).rejects.toThrow();
    expect(service.saveSkill).not.toHaveBeenCalled();
});

it.each(['', '[', '[]', 'name: []'])('rejects invalid Skill writes %j without saving', async content => {
    const { engine, service } = fixture();
    await expect(engine.driver.writeContent('/original', content)).rejects.toThrow();
    expect(service.saveSkill).not.toHaveBeenCalled();
});

it('creates an empty draft and applies valid YAML patches without losing existing instructions', async () => {
    const { engine, service } = fixture();
    expect((await engine.driver.createFile({ parentPath: '/', name: 'New Skill.yaml', content: '' })).path).toBe('/new-skill');
    expect(service.saveSkill.mock.calls[0][0]).toMatchObject({ id: 'new-skill', name: 'New Skill', enabled: false });
    await engine.driver.writeContent('/original', 'name: Renamed');
    expect(service.saveSkill.mock.calls[1][0]).toMatchObject({ id: 'original', name: 'Renamed', instructions: 'Keep instructions' });
});

it('reports write and identity cleanup failures instead of emitting a successful deletion', async () => {
    const { engine, service } = fixture(), failure = new Error('Storage unavailable');
    service.saveSkill.mockRejectedValueOnce(failure);
    await expect(engine.driver.writeContent('/original', 'name: Renamed')).rejects.toBe(failure);
    const deleted = vi.fn(); engine.on('node:deleted', deleted);
    service.deleteSkill.mockRejectedValueOnce(failure);
    await expect(engine.driver.writeContent('/original', 'id: renamed')).rejects.toBe(failure);
    expect(deleted).not.toHaveBeenCalled();
});
