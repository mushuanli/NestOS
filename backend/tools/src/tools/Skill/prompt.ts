// @file: tools/src/tools/Skill/prompt.ts

export const SKILL_TOOL_NAME = 'Skill';

export const DESCRIPTION =
  '- Execute a skill within the main conversation\n' +
  '- When users ask you to perform tasks, check if any of the available skills match\n' +
  '- Skills provide specialized capabilities and domain knowledge';

export const PROMPT =
  'Skill: Load a skill to gain access to its tools and usage instructions. Use when the task requires specialized capabilities not currently available.';
