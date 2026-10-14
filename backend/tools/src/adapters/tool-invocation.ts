import type { ToolInvokeResult } from '../contracts';
import type { Tool } from '../core/Tool';
import type { ToolUseContext } from '../core/types';
import { ToolInputError } from '../core/tool-error';

const MAX_RESULT_CHARS = 100_000;
const TRUNCATION_NOTICE = '\n[output truncated]';

async function validate(tool: Tool, args: Record<string, unknown>, context: ToolUseContext) {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new ToolInputError('INVALID_ARGUMENTS', parsed.error.message);
  const validation = await tool.validateInput?.(parsed.data, context);
  if (validation && !validation.result) throw new ToolInputError('INVALID_ARGUMENTS', validation.message);
  return parsed.data;
}

export async function prepareToolInput(tool: Tool, args: Record<string, unknown>, context: ToolUseContext) {
  context.signal?.throwIfAborted();
  const input = await validate(tool, args, context);
  const permission = await tool.checkPermissions?.(input, context);
  if (permission && permission.behavior !== 'allow') {
    throw new ToolInputError('PERMISSION_DENIED', permission.reason ?? 'Tool execution denied');
  }
  const approved = permission?.updatedInput ? await validate(tool, permission.updatedInput, context) : input;
  context.signal?.throwIfAborted();
  return approved;
}

export async function toolSuccess(tool: Tool, data: unknown, started: number,
  admit?: import('../contracts').ToolInvokeRequest['admitOutput']): Promise<ToolInvokeResult> {
  const block = tool.mapToolResultToToolResultBlockParam(data, tool.name);
  const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
  if (admit) {
    const admitted = await admit(text);
    return { toolId: tool.name, success: true, durationMs: Date.now() - started,
      ...admitted, ...(admitted.contentRef ? { truncated: true } : {}) };
  }
  const limit = Math.max(0, Math.floor(Math.min(tool.maxResultSizeChars, MAX_RESULT_CHARS)));
  const notice = TRUNCATION_NOTICE.slice(0, limit);
  const serialized = JSON.stringify(data);
  const dataFits = serialized !== undefined && serialized.length <= limit;
  const truncated = text.length > limit || (serialized !== undefined && !dataFits);
  return {
    toolId: tool.name, success: true, durationMs: Date.now() - started,
    output: text.length > limit ? text.slice(0, limit - notice.length) + notice : text,
    ...(dataFits ? { data: JSON.parse(serialized) as unknown } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function toolFailure(toolId: string, error: unknown, started: number): ToolInvokeResult {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_RESULT_CHARS - 7);
  const known = error instanceof ToolInputError;
  return { toolId, success: false, output: `Error: ${message}`, durationMs: Date.now() - started,
    error: message, ...(known ? { errorCode: error.code, recoverable: true } : {}) };
}

export function invocationSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Tool execution timed out', 'TimeoutError')), timeoutMs);
  return { controller, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
