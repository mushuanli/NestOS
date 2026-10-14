import { describe, expect, it } from 'vitest';
import { fitTranscriptBudget, type FlowTaskTranscript } from '../src/flow/transcript';

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const effect = (id: string, payload: number) => ({
    effectId: id, status: 'succeeded' as const,
    request: { kind: 'llm.chat', idempotencyKey: id },
    result: 'x'.repeat(payload),
});

function page(overrides: Partial<FlowTaskTranscript> = {}): FlowTaskTranscript {
    return {
        totalEffects: 3, sessionId: 'session', runTaskId: 'run', taskId: 'task', nodeId: 'agent',
        status: 'succeeded', version: 7, input: { goal: 'g' }, output: { text: 'y'.repeat(400) },
        effects: [effect('a', 400), effect('b', 400), effect('c', 400)], interactions: {}, bytes: 0,
        ...overrides,
    };
}

describe('fitTranscriptBudget', () => {
    it('leaves a page that already fits untouched', () => {
        const fitted = fitTranscriptBudget(page(), 1_000_000);
        expect(fitted.truncated).toBeUndefined();
        expect(fitted.effects).toHaveLength(3);
        expect(fitted.bytes).toBe(size(fitted));
    });

    it('drops trailing effects and exposes the offset of the first dropped one', () => {
        const original = page();
        const budget = Math.floor(size(original) * 0.6);
        const fitted = fitTranscriptBudget(original, budget, 0);

        expect(fitted.truncated).toBe(true);
        expect(fitted.effects.length).toBeGreaterThanOrEqual(1);
        expect(fitted.effects.length).toBeLessThan(3);
        expect(fitted.effects.map(item => item.effectId)).toEqual(['a', 'b', 'c'].slice(0, fitted.effects.length));
        expect(fitted.nextOffset).toBe(fitted.effects.length);
        expect(fitted.totalEffects).toBe(3);
        expect(size(fitted)).toBeLessThanOrEqual(budget);
    });

    it('keeps the page offset when trimming a later page', () => {
        const fitted = fitTranscriptBudget(page({ effects: [effect('c', 4000)] }), 900, 2);
        expect(fitted.effects).toHaveLength(1);
        expect(fitted.nextOffset).toBeUndefined();
    });

    it('shrinks payloads before dropping the last effect', () => {
        const fitted = fitTranscriptBudget(page(), 900, 0);
        expect(fitted.truncated).toBe(true);
        expect(fitted.effects).toHaveLength(1);
        expect(JSON.stringify(fitted.output)).toContain('…');
        expect(size(fitted)).toBeLessThanOrEqual(900);
    });

    it('falls back to the header when the budget cannot hold payloads', () => {
        const fitted = fitTranscriptBudget(page(), 200, 0);
        expect(fitted.input).toBe('[truncated]');
        expect(fitted.output).toBe('[truncated]');
        expect(fitted.effects).toEqual([]);
        expect(fitted.nextOffset).toBe(0);
        expect(fitted.sessionId).toBe('session');
        expect(fitted.status).toBe('succeeded');
        expect(fitted.version).toBe(7);
    });
});
