// @file: tools/src/tools/Agent/AgentTool.ts
// Sub-agent delegation tool.
// Factory pattern: createAgentTool(router) returns a Tool.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import type { AgentDelegationPort } from '../../contracts';
import { AGENT_TOOL_NAME, DESCRIPTION } from './prompt';

const inputSchema = lazySchema(() =>
  z.strictObject({
    instruction: z.string().describe('Self-contained task instruction for the sub-agent'),
    allowed_tools: z
      .array(z.string())
      .optional()
      .describe('Tool IDs the sub-agent may use (default: file_read, glob_search, grep_search)'),
    max_rounds: z.number().optional().describe('Maximum rounds for the sub-agent (default: 10)'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    summary: z.string(),
    rounds: z.number(),
    tokenUsage: z.object({
      input: z.number(),
      output: z.number(),
    }),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

export function createAgentTool(router: AgentDelegationPort) {
  return buildTool({
    name: AGENT_TOOL_NAME,
    searchHint: 'delegate tasks to sub-agents',
    maxResultSizeChars: 50_000,

    async description() { return DESCRIPTION; },

    userFacingName(input) {
      if (!input?.instruction) return 'Agent';
      const preview = input.instruction.slice(0, 40);
      return `Agent "${preview}${input.instruction.length > 40 ? '...' : ''}"`;
    },

    getToolUseSummary(input) {
      return input?.instruction?.slice(0, 100) ?? null;
    },

    getActivityDescription(input) {
      return input?.instruction
        ? `Delegating: ${input.instruction.slice(0, 40)}`
        : 'Delegating task';
    },

    get inputSchema(): InputSchema { return inputSchema(); },
    get outputSchema(): OutputSchema { return outputSchema(); },

    isConcurrencySafe() { return false; },
    isReadOnly() { return false; },

    async prompt() { return DESCRIPTION; },

    async call(input, context) {
      const result = await router.delegate({
        instruction: input.instruction,
        allowedTools: input.allowed_tools,
        maxRounds: input.max_rounds,
        cwd: context.cwd,
      });

      const output: Output = {
        success: result.success,
        summary: result.summary,
        rounds: result.rounds,
        tokenUsage: result.tokenUsage,
      };
      return { data: output };
    },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      if (!output.success) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Sub-agent failed. Partial findings:\n${output.summary}`,
        };
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: output.summary,
      };
    },
  } satisfies ToolDef<InputSchema, Output>);
}
