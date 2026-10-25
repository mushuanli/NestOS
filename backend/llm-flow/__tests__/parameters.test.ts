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
        expect(resolveFlowParameters('${params.constructor}', {})).toBe('${params.constructor}');
        expect(resolveFlowParameters('${params.profile.constructor}', {profile: {}})).toBe('${params.profile.constructor}');
        expect(resolveFlowParameters('${params.constructor}', {constructor: 'explicit'})).toBe('explicit');
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
    it('enforces nonblank and option constraints after dynamic values have been resolved', () => {
        expect(validateFlowParameters([{ name: 'word', type: 'string', nonBlank: true }], { word: '  ' }))
            .toEqual([expect.objectContaining({ code: 'invalid-parameter' })]);
        expect(validateFlowParameters([{ name: 'mode', type: 'string', options: ['allowed'] }], { mode: 'typo' }))
            .toEqual([expect.objectContaining({ code: 'invalid-parameter' })]);
        expect(validateFlowParameters([{ name: 'mode', type: 'json', options: [{ a: 1, b: 2 }] }], { mode: { b: 2, a: 1 } })).toEqual([]);
    });
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

it('applies image policy from each field without imposing a global upload limit', async () => {
    const { validFlowImages, validImageConstraints } = await import('../src/contracts/flow-images');
    const image = (url: string) => ({ type: 'image_url', image_url: { url } });
    const png = image('data:image/png;base64,aGVsbG8=');
    const gif = image('data:image/gif;base64,aGVsbG8=');
    expect(validFlowImages(Array(5).fill(png))).toBe(true);
    expect(validFlowImages([{...png, name: 'page.png'}])).toBe(true);
    expect(validFlowImages([{...png, name: {unexpected: 'value'}}])).toBe(false);
    expect(validFlowImages([gif], { mimeTypes: ['image/gif'], maxBytes: 5 })).toBe(true);
    expect(validFlowImages([png, png], { maxItems: 1 })).toBe(false);
    expect(validFlowImages([png], { maxBytes: 4 })).toBe(false);
    expect(validFlowImages([gif], { mimeTypes: ['image/png'] })).toBe(false);
    for (const input of [[], ['data:image/png;base64,aGVsbG8='], [image('file:///private.png')], [image('data:image/png;base64,???')]]) {
        expect(validFlowImages(input)).toBe(false);
    }
    for (const constraints of [{ maxItems: 0 }, { maxBytes: -1 }, { maxItems: 1.5 }, { mimeTypes: ['text/plain'] }]) {
        expect(validImageConstraints(constraints)).toBe(false);
        expect(validateFlowParameters([{ name: 'images', type: 'json', widget: 'images', imageConstraints: constraints }], {})).toHaveLength(1);
    }
});
