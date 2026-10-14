import { describe, expect, it } from 'vitest';
import { resolveFlowParameters, validateFlowParameters } from '../src/flow/parameters';

describe('resolveFlowParameters', () => {
    it('keeps native type when a value is exactly one parameter reference', () => {
        const params = { count: 3, ok: true, data: { a: 1 } };
        expect(resolveFlowParameters('${params.count}', params)).toBe(3);
        expect(resolveFlowParameters('${params.ok}', params)).toBe(true);
        expect(resolveFlowParameters('${params.data}', params)).toEqual({ a: 1 });
    });

    it('substitutes substrings and recurses into objects/arrays', () => {
        const params = { who: 'world', n: 2 };
        expect(resolveFlowParameters('hello ${params.who}', params)).toBe('hello world');
        expect(resolveFlowParameters(
            { prompt: 'count=${params.n}', nested: ['x-${params.who}'] },
            params,
        )).toEqual({ prompt: 'count=2', nested: ['x-world'] });
    });

    it('leaves unknown references intact', () => {
        expect(resolveFlowParameters('${params.missing}', {})).toBe('${params.missing}');
    });

    it('resolves nested dotted parameter paths', () => {
        const params = { profile: { pass_score: 54, min_chars: 500 }, revision: { max_rounds: 2 } };
        expect(resolveFlowParameters('${params.profile.pass_score}', params)).toBe(54);
        expect(resolveFlowParameters('${params.revision.max_rounds}', params)).toBe(2);
        expect(resolveFlowParameters('score>=${params.profile.pass_score}', params)).toBe('score>=54');
    });

    it('falls back to a literal dotted top-level key', () => {
        expect(resolveFlowParameters('${params.profile.pass_score}', { 'profile.pass_score': 60 })).toBe(60);
    });
});

describe('validateFlowParameters', () => {
    it('reports missing required and type mismatches', () => {
        const issues = validateFlowParameters(
            [{ name: 'q', type: 'string', required: true }, { name: 'n', type: 'number' }],
            { n: 'not-a-number' },
        );
        expect(issues.map(i => i.code)).toEqual(['missing-parameter', 'invalid-parameter']);
    });

    it('accepts valid values', () => {
        const issues = validateFlowParameters(
            [{ name: 'q', type: 'string', required: true }, { name: 'n', type: 'number' }],
            { q: 'hi', n: 5 },
        );
        expect(issues).toEqual([]);
    });
});

describe('numeric runtime parameter contracts', () => {
    const schema = [{ name: 'rounds', type: 'number' as const, required: true, default: 10, minimum: 1, maximum: 1000, integer: true }];
    it('applies defaults before required validation', () => {
        expect(validateFlowParameters(schema, {})).toEqual([]);
    });
    it.each([0, -1, 1.5, 1001])('rejects invalid round count %s', rounds => {
        expect(validateFlowParameters(schema, { rounds })).toHaveLength(1);
    });
    it('accepts custom bounded integer counts', () => {
        expect(validateFlowParameters(schema, { rounds: 2 })).toEqual([]);
    });
});
