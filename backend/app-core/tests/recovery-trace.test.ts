import { expect, it } from 'vitest';
import { summarizeRecovery } from '../src/runtime/recovery-trace';

it('reports the Session count, the state/resource split and the slowest Sessions', () => {
    const line = summarizeRecovery([
        { sessionId: 'fast', state: 5, resources: 5 },
        { sessionId: 'slow', state: 300, resources: 100 },
        { sessionId: 'middle', state: 30, resources: 10 },
    ]);
    expect(line).toContain('sessions=3');
    expect(line).toContain('state=335ms');
    expect(line).toContain('resources=115ms');
    expect(line).toMatch(/slowest\[slow=400ms middle=40ms fast=10ms\]/);
});

it('stays explicit when no Session was recovered', () => {
    expect(summarizeRecovery([])).toBe('recoverSessions: no Sessions');
});
