import { expect, it } from 'vitest';
import { FlowHumanProgram } from '../src/flow/programs';

it('keeps an existing interaction when a known dependency receipt is delivered again', () => {
    const program = new FlowHumanProgram();
    const initial = program.init({ requestId: 'review', prompt: 'Review', schema: null,
        dependencies: [{ taskId: 'a', input: 'input' }, { taskId: 'b', input: 'input' }] });
    const receipt = (taskId: string) => ({ type: 'task-exited' as const, taskId, exit: { status: 'succeeded' as const, output: null } });
    const first = program.reduce(initial.state, receipt('a'));
    const ready = program.reduce(first.state, receipt('b'));
    expect(ready.actions).toHaveLength(1);
    const duplicate = program.reduce(ready.state, receipt('a'));
    expect(duplicate.actions).toBeUndefined();
    expect(duplicate.next).toEqual({ type: 'wait', on: { type: 'interaction', id: 'review' } });
    expect(program.reduce(duplicate.state, { type: 'interaction-resolved', interactionId: 'review', value: 'accepted' }).next)
        .toMatchObject({ type: 'complete' });
    expect(program.reduce(duplicate.state, receipt('unknown')).next).toMatchObject({ type: 'fail',
        error: { message: 'Expected interaction, received task-exited' } });
});
