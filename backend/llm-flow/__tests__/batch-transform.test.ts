import { expect, it } from 'vitest';
import { transformOutcome } from '../src/flow/operations';

function batch(value: unknown, batchSize: unknown = 2, parameter: unknown = 'content') {
    return transformOutcome({ operation: 'batch', value, batchSize, parameter }, {}).outputs.result.content;
}

it('partitions mixed text, image blocks and records into named argument sets in source order', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } };
    const text = { type: 'text', text: 'Keep ${param.literal} verbatim' };
    const source = [text, image, { images: [image, image], texts: ['a', 'b'] }, 'last'];
    expect(batch(source, 2)).toEqual([{ content: [text, image] }, { content: [source[2], 'last'] }]);
    expect(source).toEqual([text, image, { images: [image, image], texts: ['a', 'b'] }, 'last']);
});

it('supports text-only, image-only, partial last batches and whole-input calls', () => {
    expect(batch(['a', 'b', 'c'], 2, 'texts')).toEqual([{ texts: ['a', 'b'] }, { texts: ['c'] }]);
    const images = [{ type: 'image' }, { type: 'image' }];
    expect(batch(images, 1, 'images')).toEqual(images.map(image => ({ images: [image] })));
    expect(batch(images, 10, 'images')).toEqual([{ images }]);
    expect(batch([], 2)).toEqual([]);
});

it.each([0, -1, 1.5, '2', Number.POSITIVE_INFINITY, Number.NaN])('rejects invalid batch sizes without truncation (%s)', size => {
    expect(() => batch(['a', 'b'], size)).toThrow('batchSize must be a positive integer');
});

it.each(['__proto__', 'constructor', 'prototype', '', 'unsafe name'])('rejects unsafe argument names (%s)', parameter => {
    expect(() => batch(['a'], 1, parameter)).toThrow('batch parameter must be a safe name');
});

it.each([null, {}, 'text'])('rejects non-collection inputs (%s)', value => {
    expect(() => batch(value)).toThrow('batch input must be an array');
});

it('combines source groups or preserves their boundaries while applying the same size limit', () => {
    const source = Array.from({ length: 45 }, (_, index) => index);
    const groups = [source.slice(0, 21), source.slice(21)];
    const result = (mode: string) => transformOutcome({ operation: 'batch', value: source, groups,
        mode, batchSize: 20, parameter: 'items' }, {}).outputs.result.content as { items: number[] }[];
    expect(result('combined').map(row => row.items.length)).toEqual([20, 20, 5]);
    expect(result('grouped').map(row => row.items.length)).toEqual([20, 1, 20, 4]);
    expect(result('grouped').flatMap(row => row.items)).toEqual(source);
});

it('preserves explicit mixed-content groups, literal text and empty collection behavior', () => {
    const text = { type: 'text', text: '${param.literal}' }, image = { type: 'image_url', image_url: { url: 'asset:one' } };
    const groups = [[text, image], [image, text, image]], value = groups.flat();
    const run = (extra: Record<string, unknown>) => transformOutcome({ operation: 'batch', value,
        batchSize: 2, parameter: 'content', ...extra }, {}).outputs.result.content;
    expect(run({ groups, mode: 'grouped' })).toEqual([{ content: groups[0] }, { content: [image, text] }, { content: [image] }]);
    expect(run({ groups: [] })).toEqual(batch(value));
    expect(transformOutcome({ operation: 'batch', value: [], groups: [], mode: 'grouped' }, {}).outputs.result.content).toEqual([]);
});

it('accepts groups as the sole input so text and image assets need only be supplied once', () => {
    const image = { type: 'image', source: { type: 'asset', asset: { id: 'one' } } };
    const text = { type: 'text', text: '${param.literal}' }, groups = [[text, image], [image]];
    expect(transformOutcome({ operation: 'batch', groups, mode: 'grouped', batchSize: 2,
        parameter: 'content' }, {}).outputs.result.content).toEqual([{ content: groups[0] }, { content: groups[1] }]);
    expect(transformOutcome({ operation: 'batch', groups: [], mode: 'grouped' }, {}).outputs.result.content).toEqual([]);
});

it.each([[[1], [3]], [[1], [2], [2]], [[2], [1]], [[1], []], [1, 2], {}, null])(
    'rejects missing, duplicated, reordered or invalid groups (%j)', groups => {
        expect(() => transformOutcome({ operation: 'batch', value: [1, 2], groups }, {})).toThrow('Flow batch groups');
    });

it.each(['unknown', false, 1])('rejects unsupported grouping modes (%s)', mode => {
    expect(() => transformOutcome({ operation: 'batch', value: [1, 2], mode }, {})).toThrow('batch mode must be combined or grouped');
});
