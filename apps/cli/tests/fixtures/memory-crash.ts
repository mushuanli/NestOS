import { TaskMemoryService } from '@itookit/llm-session';

// Test-only process entry: stop at the service boundary without changing production code.
const invoke = TaskMemoryService.prototype.invoke;
TaskMemoryService.prototype.invoke = async function (toolId, args, context) {
    const target = toolId === process.env.NESTOS_TEST_MEMORY_CRASH_TOOL;
    if (target && process.env.NESTOS_TEST_MEMORY_CRASH_PHASE === 'before') process.kill(process.pid, 'SIGKILL');
    const result = await invoke.call(this, toolId, args, context);
    if (target && process.env.NESTOS_TEST_MEMORY_CRASH_PHASE === 'after') process.kill(process.pid, 'SIGKILL');
    return result;
};

await import('../../src/cli');
