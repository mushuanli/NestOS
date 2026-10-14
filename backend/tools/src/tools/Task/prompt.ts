// @file: tools/src/tools/Task/prompt.ts

export const TASK_CREATE_NAME = 'TaskCreate';
export const TASK_GET_NAME = 'TaskGet';
export const TASK_LIST_NAME = 'TaskList';
export const TASK_UPDATE_NAME = 'TaskUpdate';
export const TASK_OUTPUT_NAME = 'TaskOutput';
export const TASK_STOP_NAME = 'TaskStop';

export const TASK_CREATE_DESCRIPTION =
  '- Creates a structured task list for the current coding session\n' +
  '- Helps track progress, organize complex tasks, and demonstrate thoroughness\n' +
  '- Tasks should have: subject (actionable title in imperative form), description (what needs to be done)\n' +
  '- Use for complex multi-step tasks, non-trivial work, or when user provides multiple tasks';

export const TASK_GET_DESCRIPTION =
  '- Retrieves a task by its ID from the task list\n' +
  '- Shows full task details: subject, description, status, dependencies\n' +
  '- Use before starting work on a task to verify requirements';

export const TASK_LIST_DESCRIPTION =
  '- Lists all tasks in the task list\n' +
  '- Shows task ID, subject, status, and blocking dependencies\n' +
  '- Use to check overall progress and find available tasks';

export const TASK_UPDATE_DESCRIPTION =
  '- Updates a task in the task list\n' +
  '- Mark tasks as in_progress when starting, completed when done\n' +
  '- Can update subject, description, status, and dependencies\n' +
  '- Use deleted status to permanently remove tasks';

export const TASK_OUTPUT_DESCRIPTION =
  '- Retrieves output from a running or completed background task\n' +
  '- Supports blocking mode (wait for completion) and non-blocking mode (poll current state)\n' +
  '- Returns retrieval_status: success, timeout, or not_ready\n' +
  '- Use when a background task (shell command, agent) has been started and you need its result';

export const TASK_STOP_DESCRIPTION =
  '- Stops a running background task by its ID\n' +
  '- Takes a task_id parameter identifying the task to stop\n' +
  '- Returns a success or failure status\n' +
  '- Use to terminate long-running background tasks';

