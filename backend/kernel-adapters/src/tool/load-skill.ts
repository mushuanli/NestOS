// @file: kernel-adapters/src/tool/load-skill.ts
// load_skill tool — dynamically activates an agent Skill.
//
// Handler is a factory (not a plain export) because it needs a live ISkillService
// reference, which is only available after services are wired up in the factory.

import type { ISkillService } from '@itookit/tools/contracts';
import type { ToolMeta, ToolDefinition, ToolHandler } from '@itookit/tools/contracts';

export const loadSkillMeta: ToolMeta = {
    id: 'load_skill',
    name: 'Load Skill',
    description: 'Dynamically load an agent skill to gain access to new tools and instructions',
    sideEffect: 'none',
    timeoutMs: 5_000,
    type: 'builtin',
    enabled: true,
    tags: ['skill', 'meta'],
    // The durable tool adapter uses this metadata to persist the loaded Skill ID.
    skillLoaderArgKey: 'skill_id',
};

export const loadSkillDefinition: ToolDefinition = {
    name: 'load_skill',
    description:
        'Load a skill to gain access to its tools and usage instructions. ' +
        'Use when the task requires specialized capabilities not currently available. ' +
        'Check the Available Skills list in the system prompt for valid skill IDs.',
    parameters: {
        type: 'object',
        properties: {
            skill_id: {
                type: 'string',
                description: 'ID of the skill to load (from the Available Skills list)',
            },
        },
        required: ['skill_id'],
    },
};

/** Returns a ToolHandler that delegates to the provided ISkillService. */
export function createLoadSkillHandler(skillService: ISkillService): ToolHandler {
    return async (args) => {
        const skillId = args['skill_id'] as string | undefined;
        if (!skillId) throw new Error('skill_id argument is required');

        // L1: action skills with disableModelInvocation must not be loaded by the model.
        const skill = skillService.getSkill(skillId);
        if (skill?.disableModelInvocation) {
            throw new Error(`Skill "${skillId}" cannot be loaded by the model`);
        }

        const result = await skillService.loadSkill(skillId);
        if (!result.success) throw new Error(result.error ?? `Failed to load Skill: ${skillId}`);
        return [
            `Skill "${skillId}" loaded. Bound tool IDs: ${result.toolIds.join(', ') || '(none)'}`,
            result.instructions ?? skill?.instructions ?? '',
            result.compactInstructions ? `Critical rules:\n${result.compactInstructions}` : '',
        ].filter(Boolean).join('\n\n');
    };
}
