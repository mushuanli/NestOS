import type { SkillDefinition } from '@itookit/tools/contracts';

export function validateSkillIndexLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Skill index byte limit must be a nonnegative safe integer');
}

/** Keep complete metadata entries and count omissions; never truncate JSON or Skill IDs. */
export function skillIndexPrompt(skills: SkillDefinition[], limit = 8192): string {
    validateSkillIndexLimit(limit);
    if (!skills.length || !limit) return '';
    const selected: Array<{ id: string; name: string; description: string }> = [];
    const encode = () => `Available skills (load explicitly when needed):\n${JSON.stringify({ skills: selected, omitted: skills.length - selected.length })}`;
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    if (bytes(encode()) > limit) return '';
    for (const skill of [...skills].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
        selected.push({ id: skill.id, name: skill.name, description: skill.description });
        if (bytes(encode()) > limit) selected.pop();
    }
    return encode();
}
