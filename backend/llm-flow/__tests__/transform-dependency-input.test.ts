import {expect, it} from 'vitest';
import {FlowValueProgram} from '../src/flow/programs';

it.each([null, {cards: [{name: 'apple'}], groups: [[{name: 'apple'}]]}])(
    'keeps the explicit dependency input instead of a previously injected global prompt (%j)', value => {
        const program = new FlowValueProgram();
        const initial = program.init({operation: 'transform', nodeId: 'normalize', config: {},
            inputs: {prompt: 'Global request'}, dependencies: [{taskId: 'prepare', input: 'input', output: 'result'}]});
        const final = program.reduce(initial.state, {type: 'task-exited', taskId: 'prepare',
            exit: {status: 'succeeded', output: {outputs: {result: {outputName: 'result', type: 'json', content: value}}}}});
        expect(final.next).toMatchObject({type: 'complete', output: {outputs: {result: {content: value}}}});
    });

it('retains the existing first-field fallback when no canonical input is supplied', () => {
    const initial = new FlowValueProgram().init({operation: 'transform', config: {}, inputs: {prompt: 'Global request'}, dependencies: []});
    expect(initial.next).toMatchObject({type: 'complete', output: {outputs: {result: {content: 'Global request'}}}});
});
