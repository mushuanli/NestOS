// @file: tools/src/tools/Task/TaskTools.ts
// Task management tools (TaskCreate, TaskGet, TaskList, TaskUpdate).
// State lives in ToolUseContext.appState so each agent session is isolated.

import { z } from 'zod/v4';
import { buildTool, type ToolDef } from '../../core/Tool';
import { lazySchema } from '../../core/lazySchema';
import type { ToolUseContext } from '../../core/types';
import {
  TASK_CREATE_NAME, TASK_GET_NAME, TASK_LIST_NAME, TASK_UPDATE_NAME,
  TASK_OUTPUT_NAME, TASK_STOP_NAME,
  TASK_CREATE_DESCRIPTION, TASK_GET_DESCRIPTION, TASK_LIST_DESCRIPTION, TASK_UPDATE_DESCRIPTION,
  TASK_OUTPUT_DESCRIPTION, TASK_STOP_DESCRIPTION,
} from './prompt';

// ── Task data type ──

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  metadata?: Record<string, unknown>;
}

// ── Session-scoped store helpers ──
// State is stored in context.appState so concurrent agent sessions stay isolated.

const STORE_KEY = 'taskStore';
const NEXT_ID_KEY = 'taskNextId';

function getStore(context: ToolUseContext): Record<string, TaskItem> {
  if (!context.appState) return {};
  if (!context.appState[STORE_KEY]) {
    const store: Record<string, TaskItem> = {};
    context.setAppState?.(STORE_KEY, store);
    return store;
  }
  return context.appState[STORE_KEY] as Record<string, TaskItem>;
}

function allocId(context: ToolUseContext): string {
  if (!context.appState) return String(Date.now());
  const n = ((context.appState[NEXT_ID_KEY] as number) ?? 1);
  context.setAppState?.(NEXT_ID_KEY, n + 1);
  return String(n);
}

// ── TaskCreate ──

const createInputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach'),
  }),
);
type CreateInput = ReturnType<typeof createInputSchema>;

const createOutputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
      description: z.string(),
      status: z.string(),
    }),
  }),
);
type CreateOutput = z.infer<ReturnType<typeof createOutputSchema>>;

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_NAME,
  searchHint: 'create structured task items',
  maxResultSizeChars: 10_000,

  async description() { return TASK_CREATE_DESCRIPTION; },
  userFacingName(input) {
    return input?.subject ? `Create ${input.subject}` : 'Create Task';
  },
  getToolUseSummary(input) {
    return input?.subject ?? null;
  },
  getActivityDescription(input) {
    return input?.subject ? `Creating task: ${input.subject}` : 'Creating task';
  },

  get inputSchema(): CreateInput { return createInputSchema(); },
  get outputSchema() { return createOutputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return TASK_CREATE_DESCRIPTION; },

  async call(input, context) {
    const store = getStore(context);
    const id = allocId(context);
    const task: TaskItem = {
      id,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      metadata: input.metadata ?? {},
    };
    store[id] = task;
    return { data: { task: { id: task.id, subject: task.subject, description: task.description, status: task.status } } };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${output.task.id} created: ${output.task.subject}`,
    };
  },
} satisfies ToolDef<CreateInput, CreateOutput>);

// ── TaskGet ──

const getInputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('The ID of the task to retrieve'),
  }),
);
type GetInput = ReturnType<typeof getInputSchema>;

const getOutputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
      description: z.string(),
      status: z.string(),
    }).nullable(),
  }),
);
type GetOutput = z.infer<ReturnType<typeof getOutputSchema>>;

export const TaskGetTool = buildTool({
  name: TASK_GET_NAME,
  searchHint: 'get task details by ID',
  maxResultSizeChars: 10_000,

  async description() { return TASK_GET_DESCRIPTION; },
  userFacingName(input) {
    return input?.task_id ? `Get Task #${input.task_id}` : 'Get Task';
  },
  getToolUseSummary(input) {
    return input?.task_id ? `#${input.task_id}` : null;
  },

  get inputSchema(): GetInput { return getInputSchema(); },
  get outputSchema() { return getOutputSchema(); },

  isConcurrencySafe() { return true; },
  isReadOnly() { return true; },

  async prompt() { return TASK_GET_DESCRIPTION; },

  async call(input, context) {
    const store = getStore(context);
    const task = store[input.task_id];
    if (!task || task.status === 'deleted') {
      return { data: { task: null } };
    }
    return {
      data: {
        task: { id: task.id, subject: task.subject, description: task.description, status: task.status },
      },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (!output.task) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: 'Task not found' };
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${output.task.id} [${output.task.status}]: ${output.task.subject}\n${output.task.description}`,
    };
  },
} satisfies ToolDef<GetInput, GetOutput>);

// ── TaskList ──

const listInputSchema = lazySchema(() => z.strictObject({}));
type ListInput = ReturnType<typeof listInputSchema>;

const listOutputSchema = lazySchema(() =>
  z.object({
    tasks: z.array(z.object({
      id: z.string(),
      subject: z.string(),
      status: z.string(),
    })),
  }),
);
type ListOutput = z.infer<ReturnType<typeof listOutputSchema>>;

export const TaskListTool = buildTool({
  name: TASK_LIST_NAME,
  searchHint: 'list all task items',
  maxResultSizeChars: 50_000,

  async description() { return TASK_LIST_DESCRIPTION; },
  userFacingName() { return 'Task List'; },

  get inputSchema(): ListInput { return listInputSchema(); },
  get outputSchema() { return listOutputSchema(); },

  isConcurrencySafe() { return true; },
  isReadOnly() { return true; },

  async prompt() { return TASK_LIST_DESCRIPTION; },

  async call(_input, context) {
    const store = getStore(context);
    const tasks = Object.values(store)
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({ id: t.id, subject: t.subject, status: t.status }));
    return { data: { tasks } };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.tasks.length === 0) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: 'No tasks' };
    }
    const lines = output.tasks.map((t) => `- [${t.status}] #${t.id}: ${t.subject}`);
    return { tool_use_id: toolUseID, type: 'tool_result', content: lines.join('\n') };
  },
} satisfies ToolDef<ListInput, ListOutput>);

// ── TaskUpdate ──

const updateInputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('The ID of the task to update'),
    status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
    subject: z.string().optional(),
    description: z.string().optional(),
  }),
);
type UpdateInput = ReturnType<typeof updateInputSchema>;

const updateOutputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
      description: z.string(),
      status: z.string(),
    }).nullable(),
  }),
);
type UpdateOutput = z.infer<ReturnType<typeof updateOutputSchema>>;

export const TaskUpdateTool = buildTool({
  name: TASK_UPDATE_NAME,
  searchHint: 'update task status or details',
  maxResultSizeChars: 10_000,

  async description() { return TASK_UPDATE_DESCRIPTION; },
  userFacingName(input) {
    return input?.task_id ? `Update Task #${input.task_id}` : 'Update Task';
  },
  getToolUseSummary(input) {
    return input?.task_id ? `#${input.task_id}` : null;
  },
  getActivityDescription(input) {
    return input?.task_id ? `Updating Task #${input.task_id}` : 'Updating task';
  },

  get inputSchema(): UpdateInput { return updateInputSchema(); },
  get outputSchema() { return updateOutputSchema(); },

  isConcurrencySafe() { return false; },
  isReadOnly() { return false; },

  async prompt() { return TASK_UPDATE_DESCRIPTION; },

  async call(input, context) {
    const store = getStore(context);
    const task = store[input.task_id];
    if (!task) {
      return { data: { task: null } };
    }
    if (input.status) task.status = input.status;
    if (input.subject) task.subject = input.subject;
    if (input.description) task.description = input.description;
    // Mutation is in-place on the appState object reference — no setAppState needed.
    return {
      data: {
        task: { id: task.id, subject: task.subject, description: task.description, status: task.status },
      },
    };
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (!output.task) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: 'Task not found' };
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${output.task.id} updated to [${output.task.status}]: ${output.task.subject}`,
    };
  },
} satisfies ToolDef<UpdateInput, UpdateOutput>);

// ── ITaskStore interface (for host-provided task backend) ──

/**
 * Background task info returned by ITaskStore.
 * Hosts implement this to provide task lifecycle management for long-running
 * operations (shell commands, sub-agents, etc.).
 */
export interface TaskInfo {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  type: string;
  output?: string;
  error?: string;
  command?: string;
}

/**
 * Interface for a background task store.
 * Hosts must implement this and inject it via createTaskOutputTool / createTaskStopTool.
 */
export interface ITaskStore {
  /** Get a task by ID. Returns undefined if not found. */
  getTask(taskId: string): TaskInfo | undefined;

  /** Block until the task completes or times out. */
  waitForCompletion(taskId: string, timeoutMs: number): Promise<TaskInfo>;

  /** Stop a running task. */
  stopTask(taskId: string): Promise<{ success: boolean; error?: string }>;
}

// ── TaskOutput ──

const outputInputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('The task ID to get output from'),
    block: z.boolean().optional().default(true).describe('Whether to wait for completion'),
    timeout: z.number().min(0).max(600_000).optional().default(30_000).describe('Max wait time in ms'),
  }),
);
type OutputInput = ReturnType<typeof outputInputSchema>;

const outputOutputSchema = lazySchema(() =>
  z.object({
    retrievalStatus: z.enum(['success', 'timeout', 'not_ready', 'not_found']),
    taskId: z.string(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
);
type OutputOutput = z.infer<ReturnType<typeof outputOutputSchema>>;

export function createTaskOutputTool(taskStore: ITaskStore) {
  return buildTool({
    name: TASK_OUTPUT_NAME,
    searchHint: 'get output from background tasks',
    maxResultSizeChars: 100_000,

    async description() { return TASK_OUTPUT_DESCRIPTION; },
    userFacingName(input) {
      return input?.task_id ? `Task Output #${input.task_id}` : 'Task Output';
    },
    getToolUseSummary(input) {
      return input?.task_id ? `#${input.task_id}` : null;
    },
    getActivityDescription(input) {
      return input?.task_id ? `Getting output for Task #${input.task_id}` : 'Getting task output';
    },

    get inputSchema(): OutputInput { return outputInputSchema(); },
    get outputSchema() { return outputOutputSchema(); },

    isConcurrencySafe() { return true; },
    isReadOnly() { return true; },

    async prompt() { return TASK_OUTPUT_DESCRIPTION; },

    async call(input, _context) {
      const task = taskStore.getTask(input.task_id);
      if (!task) {
        return {
          data: {
            retrievalStatus: 'not_found' as const,
            taskId: input.task_id,
            error: `Task not found: ${input.task_id}`,
          },
        };
      }

      // Non-blocking mode
      if (!input.block) {
        if (task.status === 'pending' || task.status === 'running') {
          return {
            data: {
              retrievalStatus: 'not_ready' as const,
              taskId: input.task_id,
              output: task.output,
            },
          };
        }
        return {
          data: {
            retrievalStatus: 'success' as const,
            taskId: input.task_id,
            output: task.output,
            error: task.error,
          },
        };
      }

      // Blocking mode
      const completed = await taskStore.waitForCompletion(input.task_id, input.timeout ?? 30_000);
      if (completed.status === 'pending' || completed.status === 'running') {
        return {
          data: {
            retrievalStatus: 'timeout' as const,
            taskId: input.task_id,
            output: completed.output,
          },
        };
      }
      return {
        data: {
          retrievalStatus: 'success' as const,
          taskId: input.task_id,
          output: completed.output,
          error: completed.error,
        },
      };
    },

    mapToolResultToToolResultBlockParam(output, toolUseID) {
      if (output.retrievalStatus === 'not_found') {
        return { tool_use_id: toolUseID, type: 'tool_result', content: `Task not found: ${output.taskId}` };
      }
      if (output.retrievalStatus === 'timeout') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Task #${output.taskId} still running (timeout). Partial output:\n${output.output ?? '(none)'}`,
        };
      }
      if (output.retrievalStatus === 'not_ready') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Task #${output.taskId} is still running.\nCurrent output:\n${output.output ?? '(none)'}`,
        };
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Task #${output.taskId} completed.\n${output.error ? `Error: ${output.error}\n` : ''}${output.output ?? '(no output)'}`,
      };
    },
  } satisfies ToolDef<OutputInput, OutputOutput>);
}

// ── TaskStop ──

const stopInputSchema = lazySchema(() =>
  z.strictObject({
    task_id: z.string().describe('The ID of the background task to stop'),
  }),
);
type StopInput = ReturnType<typeof stopInputSchema>;

const stopOutputSchema = lazySchema(() =>
  z.object({
    taskId: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
);
type StopOutput = z.infer<ReturnType<typeof stopOutputSchema>>;

export function createTaskStopTool(taskStore: ITaskStore) {
  return buildTool({
    name: TASK_STOP_NAME,
    searchHint: 'stop running background tasks',
    maxResultSizeChars: 10_000,

    async description() { return TASK_STOP_DESCRIPTION; },
    userFacingName(input) {
      return input?.task_id ? `Stop Task #${input.task_id}` : 'Stop Task';
    },
    getToolUseSummary(input) {
      return input?.task_id ? `#${input.task_id}` : null;
    },
    getActivityDescription(input) {
      return input?.task_id ? `Stopping Task #${input.task_id}` : 'Stopping task';
    },

    get inputSchema(): StopInput { return stopInputSchema(); },
    get outputSchema() { return stopOutputSchema(); },

    isConcurrencySafe() { return false; },
    isReadOnly() { return false; },

    async prompt() { return TASK_STOP_DESCRIPTION; },

    async validateInput(input) {
      const task = taskStore.getTask(input.task_id);
      if (!task) {
        return { result: false, message: `Task not found: ${input.task_id}`, errorCode: 1 };
      }
      if (task.status !== 'running') {
        return { result: false, message: `Task is not running: ${input.task_id} (status: ${task.status})`, errorCode: 2 };
      }
      return { result: true };
    },

    async call(input, _context) {
      const result = await taskStore.stopTask(input.task_id);
      return {
        data: {
          taskId: input.task_id,
          success: result.success,
          message: result.success
            ? `Successfully stopped task: ${input.task_id}`
            : `Failed to stop task: ${result.error ?? 'unknown error'}`,
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
  } satisfies ToolDef<StopInput, StopOutput>);
}
