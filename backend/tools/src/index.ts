// @file: tools/src/index.ts
// Public API for @itookit/tools

export type * from './contracts';

// ── Core ──
export { buildTool, toolMatchesName, findToolByName } from './core/Tool';
export type { Tool, ToolDef, AnyObject } from './core/Tool';
export { lazySchema } from './core/lazySchema';
export { globToRegex } from './core/globToRegex';
export { ToolInputError } from './core/tool-error';
export type {
  ValidationResult,
  PermissionResult,
  ToolUseContext,
  ToolResult,
  ToolResultBlockParam,
  ToolUseBlockParam,
  INativeShell,
  NativeShellResult,
} from './core/types';

// ── Tool imports (used for both exports and BUILTIN_TOOLS registry) ──
import { FileReadTool } from './tools/FileRead/FileReadTool';
import { FileWriteTool } from './tools/FileWrite/FileWriteTool';
import { FileEditTool } from './tools/FileEdit/FileEditTool';
import { GlobTool } from './tools/Glob/GlobTool';
import { GrepTool } from './tools/Grep/GrepTool';
import { BashTool, createBashTool } from './tools/Bash/BashTool';
import { TaskCreateTool, TaskGetTool, TaskListTool, TaskUpdateTool } from './tools/Task/TaskTools';
import { EnterPlanModeTool, ExitPlanModeTool, isPlanModeActive, getPlanContent } from './tools/PlanMode/PlanModeTools';
import { AskUserQuestionTool, createAskUserQuestionTool } from './tools/AskUserQuestion/AskUserQuestionTool';
import { WebFetchTool } from './tools/WebFetch/WebFetchTool';
import type { Tool } from './core/Tool';

// ── File tools ──
export { FileReadTool };
export type { Output as FileReadOutput } from './tools/FileRead/FileReadTool';
export { FileWriteTool };
export type { Output as FileWriteOutput } from './tools/FileWrite/FileWriteTool';
export { FileEditTool };
export type { Output as FileEditOutput } from './tools/FileEdit/FileEditTool';

// ── Search tools ──
export { GlobTool };
export type { Output as GlobOutput } from './tools/Glob/GlobTool';
export { GrepTool };
export type { Output as GrepOutput } from './tools/Grep/GrepTool';

// ── Shell tool ──
export { BashTool, createBashTool };
export type { Output as BashOutput } from './tools/Bash/BashTool';

// ── Skill tool ──
export { createSkillTool } from './tools/Skill/SkillTool';
export type { Output as SkillOutput } from './tools/Skill/SkillTool';

// ── Agent tool ──
export { createAgentTool } from './tools/Agent/AgentTool';
export type { Output as AgentOutput } from './tools/Agent/AgentTool';

// ── Task tools ──
export {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  createTaskOutputTool,
  createTaskStopTool,
} from './tools/Task/TaskTools';
export type { TaskItem, TaskInfo, ITaskStore } from './tools/Task/TaskTools';

// ── Plan mode tools ──
export { EnterPlanModeTool, ExitPlanModeTool, isPlanModeActive, getPlanContent };

// ── User interaction ──
export { AskUserQuestionTool, createAskUserQuestionTool };
export type {
  Output as AskUserQuestionOutput,
  AskUserQuestionCallback,
  Question as AskUserQuestion,
} from './tools/AskUserQuestion/AskUserQuestionTool';

// ── Web tools ──
export { WebFetchTool };
export type { Output as WebFetchOutput } from './tools/WebFetch/WebFetchTool';

// ── WebSearch tool (P0) ──
import { WebSearchTool, createWebSearchTool, setWebSearchProvider } from './tools/WebSearch/WebSearchTool';
export { WebSearchTool, createWebSearchTool, setWebSearchProvider };
export type {
  Output as WebSearchOutput,
  IWebSearchProvider,
  WebSearchResult,
} from './tools/WebSearch/WebSearchTool';

// ── MCP tools (P0) ──
export {
  createMCPTools,
  createSingleMCPTool,
} from './tools/MCP/MCPTool';
export type {
  MCPToolDef,
  MCPCallResult,
  IMCPClient,
} from './tools/MCP/MCPTool';
export { buildMcpToolName } from './tools/MCP/prompt';

// ── SendMessage tool (P1) ──
export { createSendMessageTool } from './tools/SendMessage/SendMessageTool';
export type {
  Output as SendMessageOutput,
  IMessageRouter,
  SendMessageResult,
} from './tools/SendMessage/SendMessageTool';

// ── ToolSearch tool (P1) ──
// Factory tool — no deferred tools exist without MCP, so ToolSearch must be
// created and registered dynamically via ToolDeviceDriver.registerToolInstance().
export { createToolSearchTool } from './tools/ToolSearch/ToolSearchTool';
export type { Output as ToolSearchOutput } from './tools/ToolSearch/ToolSearchTool';

// ── Adapter ──
export { ToolDeviceDriver } from './adapters/tool-device-driver';

// ── Tool registry (all built-in static tools) ──

/**
 * All static built-in tools (no runtime service dependencies).
 * Factory tools (createSkillTool, createAgentTool, createWebSearchTool,
 * createMCPTools, createTaskOutputTool, createTaskStopTool, createSendMessageTool,
 * createToolSearchTool) must be created and registered dynamically via
 * ToolDeviceDriver.registerToolInstance().
 */
export const BUILTIN_TOOLS: Tool[] = [
  // File
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  // Search
  GlobTool,
  GrepTool,
  // Shell
  BashTool,
  // Task
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  // Plan mode
  EnterPlanModeTool,
  ExitPlanModeTool,
  // User
  AskUserQuestionTool,
  // Web
  WebFetchTool,
  WebSearchTool,
];

export { createToolProgressReporter } from './core/progress';
export type { NativeShellOptions } from './core/types';
