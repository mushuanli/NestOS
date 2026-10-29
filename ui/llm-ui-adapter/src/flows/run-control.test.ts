import {expect, it, vi} from 'vitest';
import {createOperationLedger} from '@itookit/llm-ui';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {ControlOperations} from './control-operations';
import {FlowRunControl} from './run-control';

it('cancels a cold attached run with a frozen identity without resuming it first', async () => {
    const operations = createOperationLedger();
    const execute = vi.fn(async (command: string, request?: unknown) => {
        if (command === FlowCommand.RunGet) return {attachedFromStorage: true, taskTree: [], root: {task: {id: 'root', sessionId: 'child', status: 'waiting', control: {epoch: 2}}}};
        if (command === FlowCommand.RunCancel) {
            expect(operations.getSnapshot()[0]).toMatchObject({status: 'submitting', input: {action: 'cancel', expectedEpoch: 2, executionSessionId: 'child'}});
            expect(request).toMatchObject({sessionId: 'child', taskId: 'root', expectedEpoch: 2, requestId: operations.getSnapshot()[0].context.operationId}); return {};
        }
        throw new Error(`Unexpected control ${command}`);
    });
    const commands = {execute} as never;
    await new FlowRunControl(commands, 'child', new ControlOperations(operations, commands, 'parent')).execute('root', 'cancel', 2, () => true);
    expect(execute.mock.calls.map(([command]) => command)).toEqual([FlowCommand.RunGet, FlowCommand.RunCancel]);
    expect(operations.getSnapshot()[0].status).toBe('accepted');
});
