// @file: tools/src/tools/Skill/SkillTool.ts
// Skill loading tool — dynamically activates an agent skill.
// Factory pattern: createSkillTool(skillService) returns a Tool.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import type { SkillLoaderPort } from '../../contracts';
import { SKILL_TOOL_NAME, DESCRIPTION } from './prompt';

const inputSchema = lazySchema(() =>
  z.strictObject({
    skill_id: z.string().describe('ID of the skill to load (from the Available Skills list)'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    skillId: z.string(),
    loaded: z.boolean(),
    toolIds: z.array(z.string()),
    message: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

export function createSkillTool(skillService: SkillLoaderPort) {
  return buildTool({
    name: SKILL_TOOL_NAME,
    searchHint: 'load specialized agent skills',
    maxResultSizeChars: 10_000,

    async description() { return DESCRIPTION; },

    userFacingName(input) {
      return input?.skill_id ? `Skill "${input.skill_id}"` : 'Skill';
    },

    getToolUseSummary(input) {
      return input?.skill_id ?? null;
    },

    getActivityDescription(input) {
      return input?.skill_id ? `Loading skill ${input.skill_id}` : 'Loading skill';
    },

    get inputSchema(): InputSchema { return inputSchema(); },
    get outputSchema(): OutputSchema { return outputSchema(); },

    isConcurrencySafe() { return false; },
    isReadOnly() { return true; },

    async prompt() { return DESCRIPTION; },

    async call(input) {
      const skillId = input.skill_id;
      const result = await skillService.loadSkill(skillId);

      const output: Output = result.success
        ? { skillId, loaded: true, toolIds: result.toolIds, message: `Skill "${skillId}" loaded successfully` }
        : { skillId, loaded: false, toolIds: [], message: `Failed to load skill "${skillId}": ${result.error}` };

      return { data: output };
    },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: output.loaded
          ? `${output.message}. New tools: ${output.toolIds.join(', ')}`
          : `Error: ${output.message}`,
      };
    },
  } satisfies ToolDef<InputSchema, Output>);
}
