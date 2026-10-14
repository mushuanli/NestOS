// @file: tools/src/tools/AskUserQuestion/AskUserQuestionTool.ts
// User question tool — presents multiple-choice questions to the user.
//
// Use createAskUserQuestionTool(callback) to inject a real UI handler (Tauri, webapp, HITL).
// The default AskUserQuestionTool (no callback) returns structured question data for the UI
// layer to intercept via runtime.onIntercept('agent:tool:start').

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { ASK_USER_QUESTION_NAME, DESCRIPTION } from './prompt';

// ── Schema ──

const questionOptionSchema = lazySchema(() =>
  z.object({
    label: z.string().describe('Display text for the option (1-5 words)'),
    description: z.string().describe('What this option means'),
  }),
);

const questionSchema = lazySchema(() =>
  z.object({
    question: z.string().describe('The complete question to ask the user'),
    header: z.string().describe('Short label (max 12 chars)'),
    options: z.array(questionOptionSchema()).min(2).max(4).describe('2-4 mutually exclusive choices'),
    multiSelect: z.boolean().optional().describe('Allow multiple answers'),
  }),
);

const inputSchema = lazySchema(() =>
  z.strictObject({
    questions: z.array(questionSchema()).min(1).max(4).describe('1-4 questions'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    answers: z.record(z.string(), z.string()),
    message: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;
export type QuestionOption = z.infer<ReturnType<typeof questionOptionSchema>>;
export type Question = z.infer<ReturnType<typeof questionSchema>>;

/** Callback type for a real UI handler. */
export type AskUserQuestionCallback = (questions: Question[]) => Promise<Record<string, string>>;

// ── Factory ──

/**
 * Create an AskUserQuestion tool.
 *
 * @param onQuestion - Optional UI handler. When provided, the tool blocks until the
 *   handler resolves with user answers. When omitted, the tool returns structured
 *   question data intended for interception by the UI layer.
 */
export function createAskUserQuestionTool(onQuestion?: AskUserQuestionCallback) {
  return buildTool({
    name: ASK_USER_QUESTION_NAME,
    searchHint: 'ask user multiple-choice questions',
    maxResultSizeChars: 5_000,

    async description() { return DESCRIPTION; },

    userFacingName(input) {
      if (input?.questions?.length) {
        return `Ask: ${input.questions[0].header}`;
      }
      return 'Ask User';
    },

    getToolUseSummary(input) {
      if (!input?.questions?.length) return null;
      return `${input.questions.length} question(s)`;
    },

    get inputSchema(): InputSchema { return inputSchema(); },
    get outputSchema(): OutputSchema { return outputSchema(); },

    isConcurrencySafe() { return false; },
    isReadOnly() { return true; },

    async prompt() { return DESCRIPTION; },

    async call(input, _context) {
      if (onQuestion) {
        const answers = await onQuestion(input.questions);
        return {
          data: {
            answers,
            message: `User answered ${Object.keys(answers).length} question(s)`,
          },
        };
      }

      // No handler: return structured data for UI-layer interception.
      const formatted = input.questions
        .map(
          (q, i) =>
            `${i + 1}. [${q.multiSelect ? 'Multi' : 'Single'}] ${q.header}: ${q.question}\n` +
            `   Options: ${q.options.map((o) => `"${o.label}" — ${o.description}`).join(' | ')}`,
        )
        .join('\n\n');

      return {
        data: {
          answers: {},
          message: `Questions presented:\n\n${formatted}\n\n(Answers must be collected by the UI layer)`,
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
  } satisfies ToolDef<InputSchema, Output>);
}

/** Default tool instance (no UI handler — returns structured data for interception). */
export const AskUserQuestionTool = createAskUserQuestionTool();
