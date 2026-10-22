import { expect, it } from 'vitest';
import { scopedParameters } from '../src/flow/structured/references';
import type { DagRunSpec } from '../src/contracts';

const spec = (parameterSet = 0): DagRunSpec => ({ nodes: [], edges: [], parameterScopes: { 'call/0/': {
    parent: '', source: 'call__input', parameterSet, values: {}, defaults: { text: 'fallback' },
    schema: [{ name: 'text', type: 'string', default: 'fallback' }],
} } });
const output = (value: unknown) => ({ call__input: { outputs: { result: { outputName: 'result', type: 'json', content: value } } } });

it.each([-1, 0.5, 1, 100])('rejects a restored row index outside the saved parameter array (%s)', index => {
    expect(() => scopedParameters(spec(index), 'call/0/work', {}, output({ parameters: {}, parameterSets: [{ text: 'private-input' }] })))
        .toThrow(`Invalid Flow call parameter-set index: ${index}`);
});
it.each([null, [], 'private-input'])('rejects a malformed saved row instead of executing defaults (%j)', row => {
    expect(() => scopedParameters(spec(), 'call/0/work', {}, output({ parameters: {}, parameterSets: [row] })))
        .toThrow('Invalid Flow call parameter-set row: 0');
});
it.each([{ parameterSets: [{}] }, { parameters: [], parameterSets: [{}] }, { parameters: {}, parameterSets: 'private-input' }])
('rejects malformed saved input envelopes without exposing their contents (%j)', value => {
    expect(() => scopedParameters(spec(), 'call/0/work', {}, output(value))).toThrow('Invalid Flow call parameter-set source');
});
it('preserves valid common values, row overrides and literal data on recovery', () => {
    expect(scopedParameters(spec(), 'call/0/work', {}, output({ parameters: { text: 'common' }, parameterSets: [{ text: '${param.private}' }] })))
        .toEqual({ text: '${param.private}' });
    expect(scopedParameters(spec(), 'call/0/work', {}, output({ parameters: {}, parameterSets: [{}] }))).toEqual({ text: 'fallback' });
});
