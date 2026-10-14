// @file: tools/src/tools/PlanMode/PlanModeTools.ts
// Plan mode tools — enter and exit planning phase.
// State lives in ToolUseContext.appState so concurrent agent sessions stay isolated.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import type { ToolUseContext } from '../../core/types';
import {
  ENTER_PLAN_MODE_NAME, EXIT_PLAN_MODE_NAME,
  ENTER_PLAN_MODE_DESCRIPTION, EXIT_PLAN_MODE_DESCRIPTION,
} from './prompt';

// ── State keys ──
const PLAN_ACTIVE_KEY = 'planModeActive';
const PLAN_CONTENT_KEY = 'planModeContent';

// ── Public helpers ──

/**
 * Check if plan mode is currently active for the given app state.
 * Pass the ToolUseContext.appState reference obtained from the driver.
 */
export function isPlanModeActive(appState?: Record<string, unknown>): boolean {
  return (appState?.[PLAN_ACTIVE_KEY] as boolean) ?? false;
}

/**
 * Get the last submitted plan content for the given app state.
 * Pass the ToolUseContext.appState reference obtained from the driver.
 */
export function getPlanContent(appState?: Record<string, unknown>): string {
  return (appState?.[PLAN_CONTENT_KEY] as string) ?? '';
}

// ── EnterPlanMode ──

const enterInputSchema = lazySchema(() => z.strictObject({}));
type EnterInput = ReturnType<typeof enterInputSchema>;

interface EnterOutput {
  mode: 'plan';
  message: string;
}

export const EnterPlanModeTool = buildTool({
  name: ENTER_PLAN_MODE_NAME,
  searchHint: 'enter read-only planning phase',
  maxResultSizeChars: 5_000,

  async description() { return ENTER_PLAN_MODE_DESCRIPTION; },
  userFacingName() { return 'Plan Mode'; },
  getToolUseSummary() { return 'Enter plan mode'; },

  get inputSchema(): EnterInput { return enterInputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return ENTER_PLAN_MODE_DESCRIPTION; },

  async call(_input, context: ToolUseContext) {
    context.setAppState?.(PLAN_ACTIVE_KEY, true);
    return {
      data: {
        mode: 'plan' as const,
        message:
          'Entering plan mode. Explore the codebase and design an implementation approach. ' +
          'Use ExitPlanMode when ready for review.',
      },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    };
  },
} satisfies ToolDef<EnterInput, EnterOutput>);

// ── ExitPlanMode ──

const exitInputSchema = lazySchema(() =>
  z.strictObject({
    plan_content: z.string().optional().describe('The plan content to submit for review'),
  }),
);
type ExitInput = ReturnType<typeof exitInputSchema>;

interface ExitOutput {
  approved: boolean;
  message: string;
}

export const ExitPlanModeTool = buildTool({
  name: EXIT_PLAN_MODE_NAME,
  searchHint: 'submit plan for user approval',
  maxResultSizeChars: 10_000,

  async description() { return EXIT_PLAN_MODE_DESCRIPTION; },
  userFacingName() { return 'Submit Plan'; },
  getToolUseSummary() { return 'Exit plan mode'; },

  get inputSchema(): ExitInput { return exitInputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return EXIT_PLAN_MODE_DESCRIPTION; },

  async call(input, context: ToolUseContext) {
    context.setAppState?.(PLAN_ACTIVE_KEY, false);
    context.setAppState?.(PLAN_CONTENT_KEY, input.plan_content ?? '');
    return {
      data: {
        approved: true,
        message: 'Plan submitted for review. Plan mode exited. Ready to implement.',
      },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    };
  },
} satisfies ToolDef<ExitInput, ExitOutput>);
