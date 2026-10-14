import { expect, it } from 'vitest';
import { mergeExecutionMode } from '../src/session/execution-mode-policy';

it('keeps an admitted mode despite stale unlock and undefined preference patches', () => {
    expect(mergeExecutionMode({ executionMode: 'agent', executionModeLocked: true }, { executionMode: undefined, executionModeLocked: false }))
        .toEqual({ executionMode: 'agent', executionModeLocked: true });
    expect(() => mergeExecutionMode({ executionMode: 'agent', executionModeLocked: true }, { executionMode: 'chat' })).toThrow();
});
it('normalizes an omitted locked mode and rejects invalid new modes', () => {
    expect(mergeExecutionMode({ executionModeLocked: true }, {})).toEqual({ executionMode: 'chat', executionModeLocked: true });
    expect(() => mergeExecutionMode({}, { executionMode: 'invalid' as never })).toThrow('Invalid chat execution mode');
});
