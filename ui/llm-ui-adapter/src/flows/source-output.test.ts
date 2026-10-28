import {expect, it} from 'vitest';
import {sourceValues} from './source-output';
it('offers return content and rejects failed runs even when partial outputs exist', () => {
    const task = {status: 'succeeded', output: {nodes: {__flow_return: {outputs: {result: {content: {text: 'complete'}}}}, partial: {outputs: {result: {content: 'ignore'}}}}}};
    expect(sourceValues({root: {task}} as any)).toEqual([{label: 'result/result', value: {text: 'complete'}}, {label: 'result/result/text', value: 'complete'}]);
    expect(() => sourceValues({root: {task: {...task, status: 'failed', exit: {error: {message: 'Tool denied'}}}}} as any)).toThrow('Tool denied');
});
