import { describe, expect, it } from 'vitest';
import { FlowAggregateProgram } from '../src/flow/programs';

const program = new FlowAggregateProgram();
const initialScheduler = { frozen: 'x'.repeat(1024 * 1024) };

describe('aggregate state projection', () => {
    it('keeps large recovery metadata in Task input and isolates mutable state', () => {
        const input = { initialScheduler, initialWorkspace: { path: '/work' }, runTasks: ['a'],
            awaitingSchedule: true, dependencies: [], variables: { names: ['before'] } };
        const decision = program.init(input);
        expect(JSON.stringify(decision.state).length).toBeLessThan(256);
        expect(decision.state).not.toHaveProperty('initialScheduler');
        expect(decision.state).not.toHaveProperty('runTasks');
        input.variables.names.push('after');
        expect(decision.state.variables).toEqual({ names: ['before'] });
        expect(input.initialScheduler).toBe(initialScheduler);
        expect(decision.next).toEqual({ type: 'wait', on: { type: 'signal' } });
    });

    it('shrinks legacy state while preserving resolved receipts, failures and variables', () => {
        const legacy = { initialScheduler, initialWorkspace: { path: '/work' },
            dependencies: [{ taskId: 'a', nodeId: 'one' }, { taskId: 'b', nodeId: 'two', tolerated: true }],
            outputs: { one: { accepted: true } }, variables: { count: 2 } };
        const decision = program.reduce(legacy as never, {
            type: 'task-exited', taskId: 'b', exit: { taskId: 'b', status: 'failed',
                error: { message: 'Rejected input' }, completedAt: 1 },
        });
        expect(decision.state.resolved).toEqual(['a', 'b']);
        expect(decision.state).not.toHaveProperty('initialScheduler');
        expect(decision.state).not.toHaveProperty('initialWorkspace');
        expect(JSON.stringify(decision.state).length).toBeLessThan(512);
        expect(decision.next).toEqual({ type: 'complete', output: {
            nodes: { one: { accepted: true }, two: null }, variables: { count: 2 },
            failures: { two: 'Rejected input' },
        } });
        expect(legacy.outputs).toEqual({ one: { accepted: true } });
    });

    it('retains scheduling and failure behavior after projecting legacy input', () => {
        const waiting = program.init({ dependencies: [], awaitingSchedule: true });
        const scheduled = program.reduce(waiting.state, { type: 'signal', signal: {
            type: 'flow.schedule.completed', payload: { dependencies: [{ taskId: 'a', nodeId: 'one' }] },
        } } as never);
        expect(scheduled.state.awaitingSchedule).toBe(false);
        const failed = program.reduce(scheduled.state, {
            type: 'task-exited', taskId: 'a', exit: { taskId: 'a', status: 'failed',
                error: { message: 'Scan refused', code: 'VALIDATION' }, completedAt: 1 },
        });
        expect(failed.next).toEqual({ type: 'fail', error: { code: 'VALIDATION', message: 'Flow node one failed: Scan refused' } });
    });
});
