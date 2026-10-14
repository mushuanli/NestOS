// @file: tools/src/tools/SendMessage/SendMessageTool.ts
// Inter-agent messaging tool.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import { SEND_MESSAGE_TOOL_NAME, DESCRIPTION } from './prompt';

// ── Public interface ──

/**
 * Result of sending a message through the router.
 */
export interface SendMessageResult {
  delivered: boolean;
  error?: string;
}

/**
 * Router interface for inter-agent message delivery.
 * Hosts must implement this to provide agent-to-agent messaging.
 */
export interface IMessageRouter {
  /**
   * Send a message to the specified recipient.
   * @param to - Recipient identifier (agent name or id)
   * @param summary - Short preview of the message
   * @param message - The message content
   */
  sendMessage(
    to: string,
    summary: string,
    message: string,
  ): Promise<SendMessageResult>;
}

// ── Schema ──

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z.string().describe('Recipient agent name or id'),
    summary: z
      .string()
      .optional()
      .describe('Short 5-10 word preview of the message'),
    message: z.string().describe('The message content to send'),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    delivered: z.boolean(),
    message: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;

export type Output = z.infer<OutputSchema>;

// ── Factory ──

export function createSendMessageTool(router: IMessageRouter) {
  return buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'send messages between agents',
    maxResultSizeChars: 10_000,

    async description() {
      return DESCRIPTION;
    },

    userFacingName(input) {
      return input?.to ? `Send to ${input.to}` : 'Send Message';
    },

    getToolUseSummary(input) {
      if (!input?.to) return null;
      const preview = input.summary ?? input.message?.slice(0, 60);
      return `→ ${input.to}: ${preview}`;
    },

    getActivityDescription(input) {
      return input?.to ? `Sending message to ${input.to}` : 'Sending message';
    },

    get inputSchema(): InputSchema {
      return inputSchema();
    },
    get outputSchema(): OutputSchema {
      return outputSchema();
    },

    isConcurrencySafe() {
      return false;
    },
    isReadOnly() {
      return false;
    },

    async prompt() {
      return DESCRIPTION;
    },

    async validateInput(input) {
      if (!input.to.trim()) {
        return {
          result: false,
          message: 'Recipient name must not be empty',
          errorCode: 1,
        };
      }
      if (!input.message.trim()) {
        return {
          result: false,
          message: 'Message must not be empty',
          errorCode: 2,
        };
      }
      return { result: true };
    },

    async call(input, _context) {
      const summary = input.summary ?? input.message.slice(0, 60);
      const result = await router.sendMessage(
        input.to.trim(),
        summary,
        input.message,
      );

      return {
        data: {
          delivered: result.delivered,
          message: result.delivered
            ? `Message sent to ${input.to}`
            : `Failed to send message to ${input.to}: ${result.error ?? 'unknown error'}`,
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
