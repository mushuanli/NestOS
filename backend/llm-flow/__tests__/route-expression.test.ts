import { describe, expect, it } from 'vitest';
import { resolve, routeOutcome, transformOutcome } from '../src/flow/operations';

describe('routeOutcome expressions', () => {
    it('evaluates numeric comparisons (gte/lt)', () => {
        const config = {
            mode: 'exclusive' as const,
            rules: [
                { edgeId: 'pass', expression: { kind: 'gte' as const, args: [{ kind: 'path' as const, path: ['input', 'score'] }, { kind: 'literal' as const, value: 54 }] } },
            ],
            defaultEdgeId: 'retry',
        };
        expect(routeOutcome(config, { input: { score: 55 } }).effects).toContainEqual({ type: 'activate-edge', edgeId: 'pass' });
        expect(routeOutcome(config, { input: { score: 53 } }).effects).toContainEqual({ type: 'activate-edge', edgeId: 'retry' });

        const minChars = {
            mode: 'exclusive' as const,
            rules: [{ edgeId: 'enough', expression: { kind: 'gt' as const, args: [{ kind: 'path' as const, path: ['input', 'chars'] }, { kind: 'literal' as const, value: 500 }] } }],
        };
        expect(routeOutcome(minChars, { input: { chars: 501 } }).effects).toContainEqual({ type: 'activate-edge', edgeId: 'enough' });
    });

    it('reads flow parameters via param kind', () => {
        const config = {
            mode: 'exclusive' as const,
            rules: [
                { edgeId: 'rewrite', expression: { kind: 'eq' as const, args: [{ kind: 'param' as const, path: ['review', 'mode'] }, { kind: 'literal' as const, value: 'review_and_rewrite' }] } },
            ],
            defaultEdgeId: 'report',
        };
        const outcome = routeOutcome(config, {}, { review: { mode: 'review_and_rewrite' } });
        expect(outcome.effects).toContainEqual({ type: 'activate-edge', edgeId: 'rewrite' });
    });

    it('combines param thresholds with numeric comparison (loop exit)', () => {
        const config = {
            mode: 'exclusive' as const,
            rules: [
                { edgeId: 'exit', expression: { kind: 'gte' as const, args: [{ kind: 'path' as const, path: ['input', 'score'] }, { kind: 'param' as const, path: ['profile', 'pass_score'] }] } },
            ],
            defaultEdgeId: 'rewrite',
        };
        // 评分 55 >= pass_score 54 → 退出 loop。
        expect(routeOutcome(config, { input: { score: 55 } }, { profile: { pass_score: 54 } }).effects)
            .toContainEqual({ type: 'activate-edge', edgeId: 'exit' });
        // 评分 53 < 54 → 继续改写。
        expect(routeOutcome(config, { input: { score: 53 } }, { profile: { pass_score: 54 } }).effects)
            .toContainEqual({ type: 'activate-edge', edgeId: 'rewrite' });
    });

    it('parses upstream JSON text for a numeric field', () => {
        const config = {
            mode: 'exclusive' as const,
            rules: [
                { edgeId: 'pass', expression: { kind: 'gte' as const, args: [{ kind: 'path' as const, path: ['input', 'score'] }, { kind: 'literal' as const, value: 54 }] } },
            ],
            defaultEdgeId: 'retry',
        };
        // agent 节点输出的是 JSON 文本，route 应能解析后取字段。
        expect(routeOutcome(config, { input: '{"score":55}' }).effects)
            .toContainEqual({ type: 'activate-edge', edgeId: 'pass' });
        expect(routeOutcome(config, { input: '{"score":53}' }).effects)
            .toContainEqual({ type: 'activate-edge', edgeId: 'retry' });
    });
});

describe('safe expression paths', () => {
    it.each(['param', 'path'] as const)('reads array length and indices from %s values', kind => {
        const read = (items: unknown, path: string[]) => resolve({ kind, path: ['items', ...path] }, { items }, { items } as never);
        expect(read([], ['length'])).toBe(0);
        expect(read([{ name: 'apple' }, null], ['length'])).toBe(2);
        expect(read([{ name: 'apple' }], ['0', 'name'])).toBe('apple');
        expect(read([null], ['0'])).toBeNull();
        expect(read([], ['0'])).toBeUndefined();
        expect(read(null, ['length'])).toBeUndefined();
        expect(read(undefined, ['length'])).toBeUndefined();
        expect(read([null], ['0', 'missing'])).toBeUndefined();
    });

    it.each(['param', 'path'] as const)('rejects inherited object fields and non-index array fields for %s', kind => {
        const object = Object.assign(Object.create({ hidden: 'secret' }), { own: null });
        const items = Object.assign(['first', 'second'], { extra: 'secret' });
        const read = (path: string[]) => resolve({ kind, path }, { object, items }, { object, items } as never);
        expect(read(['object', 'own'])).toBeNull();
        for (const key of ['hidden', 'constructor', '__proto__', 'toString']) expect(read(['object', key])).toBeUndefined();
        for (const key of ['extra', 'constructor', '__proto__', 'map', '-1', '01', '1.0', '+1', '1e0', '9007199254740992']) {
            expect(read(['items', key])).toBeUndefined();
        }
        const sparse = new Array(1);
        Object.setPrototypeOf(sparse, { 0: 'inherited' });
        expect(resolve({ kind, path: ['items', '0'] }, { items: sparse }, { items: sparse })).toBeUndefined();
    });

    it('preserves upstream JSON parsing, parameter literals and own artifact content', () => {
        expect(resolve({ kind: 'path', path: ['input', '0', 'name'] }, { input: '[{"name":"apple"}]' })).toBe('apple');
        expect(resolve({ kind: 'param', path: ['input', '0'] }, {}, { input: '[1]' })).toBeUndefined();
        const inherited = Object.create({ content: 'secret' });
        expect(resolve({ kind: 'path', path: ['input'] }, { input: inherited })).toBe(inherited);
        expect(resolve({ kind: 'path', path: ['input'] }, { input: { content: null } })).toBeNull();
        expect(transformOutcome({ operation: 'pick', value: [{ name: 'apple' }], path: ['0', 'name'] }, {}).outputs.result.content).toBe('apple');
    });

    it('routes nonempty arrays using an explicit existence guard and numeric length', () => {
        const length = { kind: 'param' as const, path: ['images', 'length'] };
        const config = { defaultEdgeId: 'text', rules: [{ edgeId: 'images', expression: { kind: 'and', args: [
            { kind: 'exists', args: [length] }, { kind: 'gt', args: [length, { kind: 'literal', value: 0 }] },
        ] } }] };
        for (const parameters of [{}, { images: null }, { images: [] }]) {
            expect(routeOutcome(config, {}, parameters).effects).toContainEqual({ type: 'activate-edge', edgeId: 'text' });
        }
        expect(routeOutcome(config, {}, { images: ['image'] }).effects).toContainEqual({ type: 'activate-edge', edgeId: 'images' });
    });
});
