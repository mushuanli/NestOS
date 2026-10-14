import { describe, expect, it } from 'vitest';
import { DurablePlanProgram, type DurablePlanInput } from './plan-program';

describe('DurablePlanProgram', () => {
    it('generates a plan and persists an approval interaction', () => {
        const program = new DurablePlanProgram();
        const initial = program.init(input());
        const planning = program.reduce(initial.state, capability());
        const reviewing = program.reduce(planning.state, llmResponse('1. Inspect\n2. Implement'));

        expect(planning.actions?.[0]).toMatchObject({
            type: 'effect', effect: { kind: 'llm.chat', grants: [{ handleId: 'llm-handle' }] },
        });
        expect(reviewing.actions?.[0]).toMatchObject({
            type: 'request-interaction',
            interaction: { id: 'approve:plan', payload: { plan: '1. Inspect\n2. Implement' } },
        });
    });

    it('completes with the persisted approval decision', () => {
        const program = new DurablePlanProgram();
        const planning = program.reduce(program.init(input()).state, capability());
        const reviewing = program.reduce(planning.state, llmResponse('Plan'));
        const approved = program.reduce(reviewing.state, {
            type: 'interaction-resolved', interactionId: 'approve:plan', value: { approved: true },
        });

        expect(approved.next).toEqual({ type: 'complete', output: { plan: 'Plan', approved: true } });
    });
});

function input(): DurablePlanInput {
    return {
        sessionId: 'session-1', roundId: 'plan-1', connectionId: 'connection-1', goal: 'Add tests',
    };
}

function capability() {
    return {
        type: 'signal' as const,
        sequence: 1,
        signal: { type: 'capabilities', payload: { llmHandleId: 'llm-handle' } },
    };
}

function llmResponse(content: string) {
    return {
        type: 'effect-completed' as const,
        effectId: 'llm-2',
        result: { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] },
    };
}
