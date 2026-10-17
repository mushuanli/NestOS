import { describe, expect, it } from 'vitest';
import { flowOutputEntries, formatFlowOutput, nodeOutputEntries } from '@itookit/llm-flow/contracts';
import { renderFlowOutput } from '../components/dag/FlowOutput';

describe('Flow result projection', () => {
    it('preserves JSON fields, false, zero, arrays, null and empty strings', () => {
        const values = [{ content: { score: 9 }, nodes: { arbitrary: true } }, false, 0, [], null, ''];
        const nodes = Object.fromEntries(values.map((value, index) => [index, { outputs: { result: value } }]));
        expect(flowOutputEntries({ nodes }).map(entry => entry.value)).toEqual(values);
        expect(formatFlowOutput({ nodes })).toContain('"score": 9');
        expect(formatFlowOutput({ nodes })).toContain('false');
        expect(formatFlowOutput({ nodes })).toContain('null');
    });
    it('unwraps only documented artifact and assistant envelopes', () => {
        expect(nodeOutputEntries({ outputs: { result: { outputName: 'result', type: 'json', content: { score: 9 } } } }))
            .toEqual([{ name: 'result', value: { score: 9 } }]);
        expect(nodeOutputEntries({ message: { role: 'assistant', content: 'answer' } })).toEqual([{ name: 'result', value: 'answer' }]);
        expect(nodeOutputEntries({ outputs: { result: { content: 'business field' } } })[0].value).toEqual({ content: 'business field' });
    });
    it('preserves root summaries and tolerated node failures alongside node outputs', () => {
        const summary = { stopReason: 'max_rounds', results: { content: { value: { score: 8 } } } };
        expect(flowOutputEntries({ nodes: {}, ...summary })).toEqual([{ name: 'result', value: summary }]);
        expect(formatFlowOutput({ nodes: { check: false }, failures: { check: 'failed' } })).toContain('failed');
    });
    it('escapes output HTML and distinguishes round-limit completion from passing', () => {
        const html = renderFlowOutput({ stopReason: 'max_rounds', completedRounds: 2, results: {
            '<script>': { value: { score: 7 }, round: 1, current: false },
        } });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('<td>7</td>');
        expect(html).toContain('max_rounds');
    });
});
