import type { ISkillService } from '@itookit/tools/contracts';
import type { ToolDefinition, ToolHandler, ToolMeta } from '@itookit/tools/contracts';

export const unloadSkillMeta: ToolMeta = {
    id: 'unload_skill', name: 'Unload Skill',
    description: 'Unload a skill from this session',
    sideEffect: 'none', timeoutMs: 5_000, type: 'builtin', enabled: true, tags: ['skill', 'meta'],
    skillUnloaderArgKey: 'skill_id',
};

export const unloadSkillDefinition: ToolDefinition = {
    name: 'unload_skill',
    description: 'Unload a skill and its registered tools from this session. Historical instructions remain in existing tasks; future explicit or automatic loading may load it again.',
    parameters: { type: 'object', properties: { skill_id: { type: 'string', description: 'ID of the skill to unload' } }, required: ['skill_id'] },
};

/** Durable tool.call removes the persisted identity before invoking this live-scope handler. */
export function createUnloadSkillHandler(skills: ISkillService): ToolHandler {
    return async args => {
        const id = args.skill_id;
        if (typeof id !== 'string' || !id.trim()) throw new Error('skill_id argument is required');
        await skills.unloadSkill(id);
        return `Skill "${id}" unloaded from this session.`;
    };
}
