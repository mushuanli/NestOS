import { expect, it } from 'vitest';
import type { ToolInvokeResult } from '@itookit/tools/contracts';
import { DurableAgentProgram } from './agent-program';

function pending(maxExchanges = 4, toolTimeoutMs?: number) {
    const program = new DurableAgentProgram();
    const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', maxExchanges, toolTimeoutMs,
        messages: [{ role: 'user', content: 'Fix code' }] });
    const llm = program.reduce(initial.state, { type: 'signal', sequence: 1,
        signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tool' } } });
    const tool = program.reduce(llm.state, { type: 'effect-completed', effectId: 'llm-exchange-1',
        result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'edit', type: 'function', function: { name: 'Edit', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] } });
    return { program, state: JSON.parse(JSON.stringify(tool.state)), actions: tool.actions };
}

const mismatch: ToolInvokeResult = { toolId: 'Edit', success: false, output: 'Read the file again',
    error: 'old_string not found', errorCode: 'EDIT_NOT_FOUND', recoverable: true, durationMs: 1 };

it.each([{ allowedToolIds: [] }, { allowedToolIds: ['Read'] }])('rejects undeclared tools before approval or execution (grants: $allowedToolIds)', ({ allowedToolIds }) => {
    const program = new DurableAgentProgram();
    const initial = program.init({ sessionId: 's', roundId: 'r', connectionId: 'c', allowedToolIds,
        approval: 'all', messages: [{ role: 'user', content: 'Read code' }] });
    const llm = program.reduce(initial.state, { type: 'signal', sequence: 1,
        signal: { type: 'capabilities', payload: { llmHandleId: 'llm', toolHandleId: 'tool' } } });
    const next = program.reduce(JSON.parse(JSON.stringify(llm.state)), { type: 'effect-completed', effectId: 'llm-exchange-1',
        result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'write', type: 'function', function: { name: 'Write', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] } });
    expect(next.next).toMatchObject({ type: 'fail', error: { code: 'TOOL_NOT_ALLOWED' } });
    expect(next.actions?.some(action => action.type === 'effect' || action.type === 'request-interaction')).not.toBe(true);
});

it('returns known tool errors to the model after restoring serialized state', () => {
    const { program, state } = pending();
    const next = program.reduce(state, { type: 'effect-completed', effectId: 'tool-1-edit', result: mismatch as never });
    expect(next.next).toEqual({ type: 'wait', on: { type: 'effect', id: 'llm-exchange-2' } });
    expect(next.state.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'edit', content: mismatch.output });
    expect(next.actions).toContainEqual(expect.objectContaining({ type: 'emit', payload: expect.objectContaining({ type: 'tool:error' }) }));
    expect(JSON.stringify(next.actions)).not.toContain('tool:success');
});

it('bounds corrective retries with the existing exchange budget', () => {
    const { program, state } = pending(1);
    const next = program.reduce(state, { type: 'effect-completed', effectId: 'tool-1-edit', result: mismatch as never });
    expect(next.next).toMatchObject({ type: 'fail', error: { code: 'BUDGET_EXHAUSTED' } });
    expect(next.actions?.some(action => action.type === 'effect')).toBe(false);
});

it('does not continue after infrastructure failure', () => {
    const { program, state } = pending();
    const next = program.reduce(state, { type: 'effect-failed', effectId: 'tool-1-edit', error: { message: 'storage offline' } });
    expect(next.next).toMatchObject({ type: 'fail', error: { message: 'storage offline' } });
    expect(next.actions?.some(action => action.type === 'effect')).toBe(false);
});

it('keeps legacy unsuccessful tool results fatal unless explicitly recoverable', () => {
    const { program, state } = pending();
    const next = program.reduce(state, { type: 'effect-completed', effectId: 'tool-1-edit',
        result: { ...mismatch, recoverable: false } as never });
    expect(next.next.type).toBe('fail');
});

it('preserves host tool timeout across persisted exchanges', () => {
    const { program, state, actions } = pending(4, 4321);
    expect(actions).toContainEqual(expect.objectContaining({ type: 'effect', effect: expect.objectContaining({ kind: 'tool.call', timeoutMs: 4321 }) }));
    const next = program.reduce(state, { type: 'effect-completed', effectId: 'tool-1-edit', result: mismatch as never });
    const again = program.reduce(JSON.parse(JSON.stringify(next.state)), { type: 'effect-completed', effectId: 'llm-exchange-2',
        result: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [
            { id: 'retry', type: 'function', function: { name: 'Edit', arguments: '{}' } },
        ] }, finish_reason: 'tool_calls' }] } });
    expect(again.actions).toContainEqual(expect.objectContaining({ type: 'effect', effect: expect.objectContaining({ kind: 'tool.call', timeoutMs: 4321 }) }));
});
