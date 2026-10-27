import {expect, it} from 'vitest';
import {ToolProgram, type ToolProgramInput} from './tool-program';
import type {TaskInputEvent} from '@itookit/durable-kernel';

const input = (): ToolProgramInput => ({toolId: 'fixture.save', toolVersion: '1', args: {format: 'json'},
    allowedToolIds: ['fixture.save'], approval: 'none',
    dependencies: [{taskId: 'source', input: 'input', output: 'result'}]});
const capability = {type: 'signal', signal: {type: 'capabilities', payload: {toolHandleId: 'handle'}}} as TaskInputEvent;
const exited = (content: unknown) => ({type: 'task-exited', taskId: 'source',
    exit: {status: 'succeeded', output: {outputs: {result: {content}}}}}) as TaskInputEvent;

it.each([true, false])('freezes upstream arguments before executing, capability first=%s', capabilityFirst => {
    const program = new ToolProgram(), original = input();
    const initial = program.init(original);
    original.args.format = 'changed';
    const first = program.reduce(initial.state, capabilityFirst ? capability : exited({body: 'material'}));
    expect(first.actions).toBeUndefined();
    const restored = JSON.parse(JSON.stringify(first.state));
    const ready = program.reduce(restored, capabilityFirst ? exited({body: 'material'}) : capability);
    expect(ready.actions).toContainEqual(expect.objectContaining({type: 'effect', effect: expect.objectContaining({
        request: expect.objectContaining({toolId: 'fixture.save', args: {format: 'json', body: 'material'}}),
    })}));
});

it('rejects argument collisions with a diagnostic that contains no input body', () => {
    const program = new ToolProgram();
    const failed = program.reduce(program.init(input()).state, exited({format: 'secret-value'}));
    expect(failed.next).toMatchObject({type: 'fail', error: {code: 'TOOL_INPUT_ARGUMENTS_INVALID'}});
    expect(failed.actions).toContainEqual(expect.objectContaining({type: 'emit', eventType: 'tool.input.failed'}));
    expect(JSON.stringify(failed.actions)).not.toContain('secret-value');
});

it('maps a Harness text output to an explicitly named tool argument', () => {
    const program = new ToolProgram(), request = {...input(), inputArgument: 'body'};
    const initial = program.init(request), bound = program.reduce(initial.state, capability);
    const ready = program.reduce(bound.state, exited('report text'));
    expect(ready.state.input.args).toEqual({format: 'json', body: 'report text'});
    expect(ready.next).toMatchObject({type: 'wait', on: {type: 'effect', id: 'tool'}});
});

it('keeps pending approval when duplicate dependency or capability notifications arrive', () => {
    const program = new ToolProgram(), request = {...input(), approval: 'all' as const};
    const initial = program.init(request), bound = program.reduce(initial.state, capability);
    const approval = program.reduce(bound.state, exited({body: 'material'}));
    const duplicate = program.reduce(approval.state, exited({body: 'different'}));
    expect(duplicate.next).toEqual({type: 'wait', on: {type: 'interaction', id: 'approve:tool'}});
    expect(duplicate.state.input.args).toEqual({format: 'json', body: 'material'});
});

it('does not inject control dependencies or reapply duplicate task exit notifications', () => {
    const program = new ToolProgram();
    const request = input(); request.dependencies!.push({taskId: 'control', input: 'input', injectOutput: false});
    const first = program.reduce(program.init(request).state, exited({body: 'material'}));
    const duplicate = program.reduce(first.state, exited({body: 'different'}));
    expect(duplicate.state.input.args).toEqual({format: 'json', body: 'material'});
});
