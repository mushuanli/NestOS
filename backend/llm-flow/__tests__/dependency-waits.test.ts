import { describe, expect, it } from 'vitest';
import { FlowAggregateProgram, FlowHumanProgram, FlowValueProgram } from '../src/flow/programs';

describe('Flow dependency receipts', () => {
    it.each(['value', 'human', 'aggregate'] as const)('does not re-register consumed exits for %s after restoring state', kind => {
        const program = kind === 'value' ? new FlowValueProgram()
            : kind === 'human' ? new FlowHumanProgram() : new FlowAggregateProgram();
        const dependencies = ['a', 'b'].map(taskId => ({ taskId, nodeId: taskId, input: taskId }));
        const input = kind === 'value' ? { operation: 'return', config: { returns: {} }, inputs: {}, dependencies }
            : kind === 'human' ? { requestId: 'review', prompt: 'Review', dependencies } : { dependencies };
        const initial = program.init(input as never);
        const receipt = (taskId: string) => ({ type: 'task-exited' as const, taskId,
            exit: { status: 'succeeded' as const, output: null } });
        const first = program.reduce(initial.state as never, receipt('a'));
        expect(first.next).toEqual({ type: 'wait', on: { type: 'all', waits: [{ type: 'task', id: 'b' }] } });
        // Persisted receipts survive reconstruction; an already queued duplicate is harmless.
        const restored = structuredClone(first.state);
        const duplicate = program.reduce(restored as never, receipt('a'));
        expect(duplicate.next).toEqual(first.next);
        const final = program.reduce(duplicate.state as never, receipt('b'));
        expect(final.next.type).toBe(kind === 'human' ? 'wait' : 'complete');
        if (kind === 'human') expect(final.next).toEqual({ type: 'wait', on: { type: 'interaction', id: 'review' } });
    });
});
