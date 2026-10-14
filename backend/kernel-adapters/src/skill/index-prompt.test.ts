import { expect, it } from 'vitest';
import type { SkillDefinition } from '@itookit/tools/contracts';
import { skillIndexPrompt } from './index-prompt';

const skill = (id: string, description: string, priority = 0) => ({ id, name: id, description, priority } as SkillDefinition);
const payload = (value: string) => JSON.parse(value.slice(value.indexOf('\n') + 1));

it('bounds UTF-8 bytes and retains complete metadata in priority order with omission counts', () => {
    const skills = [skill('late', '较低优先级', 2), skill('large', '过长描述'.repeat(1000), -1), skill('first', '优先说明', 0)];
    const result = skillIndexPrompt(skills, 160);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(160);
    expect(payload(result)).toEqual({ skills: [{ id: 'first', name: 'first', description: '优先说明' }], omitted: 2 });
    expect(skillIndexPrompt([...skills].reverse(), 160)).toBe(result);
});

it('uses the default cap, supports disabling the index, and rejects invalid limits', () => {
    const skills = Array.from({ length: 500 }, (_, i) => skill(String(i), 'description'.repeat(10), i));
    const result = skillIndexPrompt(skills);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(8192);
    expect(payload(result).omitted).toBeGreaterThan(0);
    expect(skillIndexPrompt(skills, 0)).toBe('');
    expect(skillIndexPrompt(skills, 1)).toBe('');
    for (const limit of [-1, 0.5, NaN, Infinity]) expect(() => skillIndexPrompt(skills, limit)).toThrow('byte limit');
});
