// @file: tools/src/tools/Agent/prompt.ts

export const AGENT_TOOL_NAME = 'Agent';

export const DESCRIPTION =
  '- Launch a new agent to handle complex, multi-step tasks autonomously\n' +
  '- The Agent tool launches specialized agents (subprocesses) that autonomously handle complex tasks\n' +
  '- Available agent types: Explore (codebase search), general-purpose (full capabilities), Plan (architecture design)\n' +
  '- Use for complex searches, multi-file analysis, or any task that would benefit from a fresh context window';

export const PROMPT =
  'Agent: Delegate a task to a sub-agent with a fresh context window. The sub-agent runs in isolation and returns a summary. Use for complex multi-step tasks that would pollute the main context window.';
