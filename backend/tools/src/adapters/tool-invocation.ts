import type { ToolInvokeResult } from '../contracts';
import type { Tool } from '../core/Tool';
import type { ToolUseContext } from '../core/types';
import { ToolInputError, ToolOutputError } from '../core/tool-error';

const MAX_RESULT_CHARS = 100_000;
const MAX_STRUCTURED_RESULT_CHARS = 16 * 1024 * 1024;
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

/** Recovery checks authority without rerunning business preconditions or changing the original arguments. */
export async function prepareToolReconciliation(tool: Tool, args: Record<string, unknown>, context: ToolUseContext) {
  context.signal?.throwIfAborted();
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) throw new ToolInputError('INVALID_ARGUMENTS', parsed.error.message);
  const permission = await tool.checkPermissions?.(parsed.data, context);
  if (permission && (permission.behavior !== 'allow' || permission.updatedInput)) {
    throw new ToolInputError('PERMISSION_DENIED', permission.reason ?? 'Reconciliation cannot change the original operation');
  }
  context.signal?.throwIfAborted();
  return parsed.data;
}

export async function toolSuccess(tool: Tool, data: unknown, started: number,
  admit?: import('../contracts').ToolInvokeRequest['admitOutput'], structured = false): Promise<ToolInvokeResult> {
  if (tool.outputSchema) {
    const parsed = tool.outputSchema.safeParse(data);
    if (!parsed.success) throw new ToolOutputError('INVALID_OUTPUT', parsed.error.message);
    data = parsed.data;
  }
  if (structured) return structuredSuccess(tool, data, started);
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

function structuredSuccess(tool: Tool, data: unknown, started: number): ToolInvokeResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data, (_key, value: unknown) => {
      if (value === undefined || ['bigint', 'function', 'symbol'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))
        throw new Error('Non-JSON output');
      return value;
    });
  } catch { throw new ToolOutputError('INVALID_OUTPUT', 'Complete JSON result required'); }
  const limit = structuredResultLimit(tool);
  if (serialized === undefined || serialized.length > limit) throw new ToolOutputError('OUTPUT_TOO_LARGE',
    `Complete JSON result requires ${serialized?.length ?? 0} characters; limit is ${limit}; return asset references for larger results`);
  return { toolId: tool.name, success: true, durationMs: Date.now() - started, output: serialized, data: JSON.parse(serialized) };
}

function structuredResultLimit(tool: Tool): number {
  const declared = tool.maxResultSizeChars ?? MAX_RESULT_CHARS;
  if (typeof declared !== 'number' || Number.isNaN(declared) || declared < 0)
    throw new ToolOutputError('INVALID_OUTPUT_LIMIT', 'Structured result limit must be a non-negative number');
  return Math.floor(Math.min(declared, MAX_STRUCTURED_RESULT_CHARS));
}

export function toolFailure(toolId: string, error: unknown, started: number): ToolInvokeResult {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_RESULT_CHARS - 7);
  const known = error instanceof ToolInputError;
  return { toolId, success: false, output: `Error: ${message}`, durationMs: Date.now() - started,
    error: message, ...(known || error instanceof ToolOutputError ? { errorCode: error.code, recoverable: known } : {}) };
}

export function invocationSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Tool execution timed out', 'TimeoutError')), timeoutMs);
  return { controller, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
