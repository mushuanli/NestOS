import { expect, it } from 'vitest';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';

it('freezes host execution policy into Flow task input without a fixed retry cap', async () => {
    const registry = createBuiltinDagPluginRegistry();
    const runtime = await registry.loadRuntime('builtin.agent');
    const config = { llmRetry: { retries: 8, backoffMs: 10 }, toolTimeoutMs: 4500 };
    const task = await runtime.createTask!({ config, inputs: {}, sessionId: 's', nodeRunId: 'node' } as never);
    config.llmRetry.retries = 0;
    expect(task.input).toMatchObject({ llmRetry: { retries: 8, backoffMs: 10 }, toolTimeoutMs: 4500 });
});

it('rejects invalid Flow tool budgets before creating a task', async () => {
    const runtime = await createBuiltinDagPluginRegistry().loadRuntime('builtin.agent');
    await expect(Promise.resolve().then(() => runtime.createTask!({ config: { toolTimeoutMs: 'invalid' }, inputs: {}, sessionId: 's', nodeRunId: 'node' } as never))).rejects.toThrow('positive safe integer');
});
