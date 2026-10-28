import {expect, it} from 'vitest';
import {messageState, toolState} from './message-state';

it.each([
    ['queued', 'pending'], ['paused', 'pending'], ['waiting-input', 'pending'], ['running', 'running'],
    ['success', 'succeeded'], ['completed', 'succeeded'], ['failed', 'failed'], ['error', 'failed'],
    ['cancelled', 'cancelled'], ['aborted', 'cancelled'], [undefined, 'unknown'], ['unrecognized', 'unknown'],
])('preserves tool execution semantics for %s', (status, expected) => {expect(toolState(status)).toBe(expected);});
it('keeps message display phases separate from execution outcomes', () => {
    expect(messageState('queued')).toBe('pending'); expect(messageState('running')).toBe('streaming');
    expect(messageState('aborted')).toBe('cancelled'); expect(messageState('success')).toBe('complete');
});
