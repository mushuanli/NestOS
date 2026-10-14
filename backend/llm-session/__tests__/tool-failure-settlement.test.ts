// Regression: a Tool Effect that fails before the tool program settles emits no `tool:*` event,
// so the live execution node created at `tool:running` stayed at RUNNING forever. The coordinator
// now settles the still-in-flight calls when the Round fails.
import { describe, expect, it } from 'vitest';
import { failedToolResult, unsettledToolErrors } from '../src/session/conversation-run-coordinator';

describe('settling in-flight tool calls on Round failure', () => {
    it('emits a terminal tool error for a call that never produced a result', () => {
        const events = unsettledToolErrors([
            { toolId: 'call-1', name: 'Bash', input: { command: 'pwd' } },
        ], 'Session Bash requires a mounted Session directory');

        expect(events).toEqual([{
            type: 'tool:error',
            call: { toolId: 'call-1', name: 'Bash', input: { command: 'pwd' },
                error: 'Session Bash requires a mounted Session directory' },
        }]);
    });

    it('leaves settled calls alone, including ones that already errored', () => {
        const events = unsettledToolErrors([
            { toolId: 'done', name: 'Read', result: 'contents' },
            { toolId: 'failed', name: 'Write', result: 'denied', isError: true },
        ], 'Task failed');

        expect(events).toEqual([]);
    });

    it('settles only the calls still in flight in a mixed list', () => {
        const events = unsettledToolErrors([
            { toolId: 'done', name: 'Read', result: 'ok' },
            { toolId: 'pending', name: 'Bash' },
        ], 'Task cancelled');

        expect(events.map(event => event.call.toolId)).toEqual(['pending']);
        expect(events[0].call.error).toBe('Task cancelled');
    });
});

describe('persisting failed tool calls with the Round', () => {
    it('records started calls as errored and keeps settled ones', () => {
        const result = failedToolResult([
            { toolId: 'done', name: 'Read', result: 'contents' },
            { toolId: 'pending', name: 'Bash', input: { command: 'pwd' } },
        ], 'Session Bash requires a mounted Session directory');

        expect(result).toEqual({
            assistantBlocks: [
                { type: 'tool_use', toolUseId: 'done', name: 'Read', input: undefined },
                { type: 'tool_use', toolUseId: 'pending', name: 'Bash', input: { command: 'pwd' } },
            ],
            toolResults: [
                { toolUseId: 'done', content: 'contents', isError: false },
                { toolUseId: 'pending', content: 'Session Bash requires a mounted Session directory', isError: true },
            ],
        });
    });

    it('returns undefined when the Round never started a tool', () => {
        expect(failedToolResult([], 'Task failed')).toBeUndefined();
    });
});
