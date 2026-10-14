import { describe, expect, it } from 'vitest';
import { ExecProgram } from './exec-program';

describe('ExecProgram', () => {
    it('binds a process capability and waits for approval', () => {
        const program = new ExecProgram();
        const initial = program.init({ command: 'pnpm test' });
        const bound = program.reduce(initial.state, capability('process-handle'));

        expect(initial.next).toEqual({ type: 'wait', on: { type: 'signal', id: 'capabilities' } });
        expect(bound.actions?.[0]).toMatchObject({
            type: 'request-interaction', interaction: { id: 'approve:exec', kind: 'approval' },
        });
    });

    it('dispatches the process effect only after approval', () => {
        const program = new ExecProgram();
        const bound = program.reduce(program.init({ command: 'pnpm test' }).state, capability('handle'));
        const approved = program.reduce(bound.state, {
            type: 'interaction-resolved', interactionId: 'approve:exec', value: { approved: true },
        });

        expect(approved.actions?.[0]).toMatchObject({
            type: 'effect',
            effect: {
                kind: 'process.exec',
                request: { resourceHandleId: 'handle', command: 'pnpm test' },
                grants: [{ handleId: 'handle', right: 'execute' }],
            },
        });
    });

    it('fails without dispatching an effect when approval is denied', () => {
        const program = new ExecProgram();
        const bound = program.reduce(program.init({ command: 'pwd' }).state, capability('handle'));
        const denied = program.reduce(bound.state, {
            type: 'interaction-resolved', interactionId: 'approve:exec', value: { approved: false },
        });

        expect(denied.actions).toBeUndefined();
        expect(denied.next).toMatchObject({ type: 'fail', error: { code: 'APPROVAL_DENIED' } });
    });
});

function capability(processHandleId: string) {
    return {
        type: 'signal' as const,
        sequence: 1,
        signal: { type: 'capabilities', payload: { processHandleId } },
    };
}
