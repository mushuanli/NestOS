// @file: tools/src/adapters/tool-device-driver.ts
// ToolDeviceDriver — bridges Tool[] → IToolService + IDeviceDriver.
// Platform-neutral Tool device driver used by KernelAdapters capability scopes.

import { z } from 'zod/v4';
import type {
  IToolService,
  ToolMeta,
  ToolDefinition,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolBatchResult,
  ToolVFSContext,
  ToolHandler,
} from '../contracts';
import type {
  DeviceContext,
  IDeviceDriver,
} from '@itookit/vfs-core';
import type { Tool } from '../core/Tool';
import type { INativeShell, ToolUseContext } from '../core/types';
import { ToolInputError } from '../core/tool-error';
import { invocationSignal, prepareToolInput, toolFailure, toolSuccess } from './tool-invocation';
import { createBashTool } from '../tools/Bash/BashTool';

// ── Registry entry ──

interface RegisteredTool {
  meta: ToolMeta;
  definition: ToolDefinition;
  tool: Tool;
}

// ── Meta/Definition builders ──

function toolMetaFromTool(tool: Tool): ToolMeta {
  return {
    id: tool.name,
    name: tool.userFacingName(undefined),
    description: '',
    sideEffect: tool.isReadOnly() ? 'none' : 'local',
    timeoutMs: 30_000,
    type: 'builtin',
    enabled: tool.isEnabled(),
    tags: tool.searchHint ? [tool.searchHint] : [],
  };
}

function toolDefinitionFromTool(tool: Tool): ToolDefinition {
  // Convert the tool's Zod input schema to a JSON Schema object for the LLM.
  let parameters: Record<string, unknown> = { type: 'object', properties: {}, required: [] };
  try {
    const schema = tool.inputSchema;
    if (schema) {
      parameters = z.toJSONSchema(schema) as Record<string, unknown>;
    }
  } catch {
    // Fall back to empty schema if conversion fails (e.g. no inputSchema defined).
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: '', // filled in by init()
      parameters,
    },
  };
}

// ── Driver ──

export class ToolDeviceDriver implements IDeviceDriver, IToolService {
  readonly handlerId = 'tools';
  readonly description = 'Built-in tool execution device';
  readonly writable = false;
  readonly streamable = false;
  readonly sessionable = false;

  private registry = new Map<string, RegisteredTool>();
  private vfsContext: ToolVFSContext | undefined = undefined;
  private fileCwd: string | undefined;

  setFileContext(ctx: ToolVFSContext, cwd: string): void {
    this.vfsContext = ctx;
    this.fileCwd = cwd;
  }
  private shellContext: INativeShell | undefined = undefined;

  /**
   * Session-scoped app state shared across all tool invocations.
   * Provides isolation for stateful tools (Task, PlanMode) between sessions.
   * Call clearSessionState() when starting a new agent session if isolation is needed.
   */
  private sessionAppState: Record<string, unknown> = {};

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      const meta = toolMetaFromTool(tool);
      const definition = toolDefinitionFromTool(tool);
      this.registry.set(tool.name, { meta, definition, tool });
    }
  }

  /**
   * Inject a native shell implemented by the owning application.
   * When set, search tools (GrepTool, GlobTool) use rg/fd instead of manual FS walking,
   * and BashTool can run in Tauri where node:child_process is unavailable.
   *
   * @example (Tauri)
   *   const shell = await TauriNativeShell.create();
   *   toolDriver.setNativeShell(shell);
   */
  setNativeShell(shell: INativeShell): void {
    this.shellContext = shell;
    // The built-in Bash tool ships disabled (no shell bound). An injected shell must
    // re-register it, otherwise getToolDefinitions() filters it out and the model is
    // never told the tool exists.
    this.registerToolInstance(createBashTool(shell));
  }

  /** Clear session-scoped app state between agent sessions for full isolation. */
  clearSessionState(): void {
    this.sessionAppState = {};
  }

  /** Register an additional tool at runtime (e.g. from Skill loading). */
  registerToolInstance(tool: Tool): void {
    const meta = toolMetaFromTool(tool);
    const definition = toolDefinitionFromTool(tool);
    this.registry.set(tool.name, { meta, definition, tool });
  }

  async init(): Promise<void> {
    for (const entry of this.registry.values()) {
      const desc = await entry.tool.description();
      entry.meta.description = desc;
      if (entry.definition.function) entry.definition.function.description = desc;
      else entry.definition.description = desc;
    }
  }

  async dispose(): Promise<void> {
    this.registry.clear();
  }

  // ── IDeviceDriver ──

  async read(_ctx: DeviceContext): Promise<string> {
    return this.listTools().map((m) => `${m.id}: ${m.description}`).join('\n');
  }

  async write(_ctx: DeviceContext): Promise<void> {}

  async ioctl(_ctx: DeviceContext, command: string, arg?: unknown): Promise<unknown> {
    if (command === 'invoke' && arg) return this.invoke(arg as ToolInvokeRequest);
    if (command === 'list') return this.listTools();
    throw new Error(`Unknown ioctl command: ${command}`);
  }

  // ── IToolService ──

  listTools(): ToolMeta[] {
    return [...this.registry.values()].map((e) => e.meta);
  }

  getToolMeta(id: string): ToolMeta | undefined {
    return this.registry.get(id)?.meta;
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.registry.values()]
      .filter((e) => e.meta.enabled)
      .map((e) => e.definition);
  }

  async invoke(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    const started = Date.now();
    const entry = this.registry.get(request.toolId);
    if (!entry) return toolFailure(request.toolId, new ToolInputError('TOOL_NOT_FOUND', `Tool not found: ${request.toolId}`), started);
    if (!entry.meta.enabled || !entry.tool.isEnabled()) {
      return toolFailure(request.toolId, new ToolInputError('TOOL_DISABLED', `Tool is disabled: ${request.toolId}`), started);
    }
    const timeoutMs = request.timeoutMs ?? entry.meta.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return toolFailure(request.toolId, new ToolInputError('INVALID_ARGUMENTS', 'Invalid tool timeout'), started);
    }
    const signal = invocationSignal(request.signal, timeoutMs);
    try {
      const context = this.invocationContext(request, timeoutMs, signal.controller);
      const args = await prepareToolInput(entry.tool, request.args, context);
      if (!entry.meta.enabled || !entry.tool.isEnabled() || this.registry.get(request.toolId) !== entry) {
        throw new ToolInputError('TOOL_DISABLED', 'Tool was disabled or replaced before execution');
      }
      const activity = entry.tool.getActivityDescription?.(args);
      if (activity) await context.onProgress?.({ message: activity });
      const result = await entry.tool.call(args, context);
      return await toolSuccess(entry.tool, result.data, started, request.admitOutput);
    } catch (error) {
      const result = toolFailure(request.toolId, error, started);
      return signal.controller.signal.aborted ? { ...result, errorCode: 'CANCELLED', recoverable: false } : result;
    } finally {
      signal.dispose();
    }
  }

  private invocationContext(request: ToolInvokeRequest, timeoutMs: number, controller: AbortController): ToolUseContext {
    const appState = this.sessionAppState;
    return {
      cwd: request.cwd ?? this.fileCwd ?? (typeof process !== 'undefined' ? process.cwd() : '/'),
      signal: controller.signal, timeoutMs, vfs: this.vfsContext, shell: this.shellContext,
      onProgress: request.onProgress,
      abortController: controller, appState,
      setAppState: (key, value) => { appState[key] = value; },
    };
  }

  async invokeBatch(requests: ToolInvokeRequest[]): Promise<ToolBatchResult> {
    const t0 = Date.now();
    const indexed = requests.map((req, idx) => ({ req, idx }));
    const reads = indexed.filter(({ req }) => {
      const entry = this.registry.get(req.toolId);
      return entry?.tool.isConcurrencySafe() ?? false;
    });
    const writes = indexed.filter(({ req }) => {
      const entry = this.registry.get(req.toolId);
      return !(entry?.tool.isConcurrencySafe() ?? false);
    });

    const slotted: ToolInvokeResult[] = new Array(requests.length);

    // Reads in parallel
    const readResults = await Promise.all(reads.map(({ req }) => this.invoke(req)));
    for (let i = 0; i < reads.length; i++) {
      slotted[reads[i].idx] = readResults[i];
    }

    // Writes serially
    for (const { req, idx } of writes) {
      slotted[idx] = await this.invoke(req);
    }

    return { results: slotted, totalDurationMs: Date.now() - t0 };
  }

  registerTool(meta: ToolMeta, definition: ToolDefinition, handler: ToolHandler): void {
    const schema = definition.function?.parameters ?? definition.parameters ?? { type: 'object' };
    // Wrap a ToolHandler as a Tool adapter for backward compatibility.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = {
      name: meta.id,
      maxResultSizeChars: 50_000,
      description() { return Promise.resolve(meta.description); },
      prompt() { return Promise.resolve(meta.description); },
      userFacingName() { return meta.name; },
      inputSchema: z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]),
      isConcurrencySafe() { return meta.sideEffect === 'none'; },
      isReadOnly() { return meta.sideEffect === 'none'; },
      isEnabled() { return meta.enabled; },
      async call(args: Record<string, unknown>, context: Record<string, unknown>) {
        const result = await handler(args, context as unknown as Parameters<typeof handler>[1]);
        return { data: result };
      },
      mapToolResultToToolResultBlockParam(data: unknown, toolUseId: string) {
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: String(data),
        };
      },
    } as unknown as Tool;
    this.registry.set(meta.id, { meta, definition, tool: adapter });
  }

  unregisterTool(id: string): void {
    this.registry.delete(id);
  }

  getService(): IToolService {
    return this;
  }
}
