import { describe, expect, it } from 'vitest';
import { routeOutcome } from '../src/flow/operations';

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
