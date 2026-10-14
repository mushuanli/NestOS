// @file: tools/src/tools/PlanMode/prompt.ts

export const ENTER_PLAN_MODE_NAME = 'EnterPlanMode';
export const EXIT_PLAN_MODE_NAME = 'ExitPlanMode';

export const ENTER_PLAN_MODE_DESCRIPTION =
  '- Switches into plan mode for designing implementation approaches\n' +
  '- In plan mode: explore codebase, design solutions, get user approval before coding\n' +
  '- Use when tasks require architectural decisions, multiple approaches, or multi-file changes\n' +
  '- Skip for simple fixes: typos, single-line changes, known patterns';

export const EXIT_PLAN_MODE_DESCRIPTION =
  '- Exits plan mode after writing the plan for user approval\n' +
  '- The plan should be written to the plan file before calling this tool\n' +
  '- User will review and approve the plan before implementation begins';
