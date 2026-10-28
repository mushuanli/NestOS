// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {prepareAgentFlow} from '../../llm-ui-adapter/src/flows/agent-flow';

const agent = {id: 'flow-agent', name: 'Flow', execution: {kind: 'flow' as const, flowId: 'test'}};
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () {this.open = true;};
    HTMLDialogElement.prototype.close = function () {this.open = false; this.dispatchEvent(new Event('close'));};
});
afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});
function prepare(parameters: unknown[], check = async () => {}, text = '/run lesson', inputGroups?: unknown[]) {
    const signal = new AbortController();
    const execute = vi.fn(async (command: string) => {
        if (command === FlowCommand.RevisionGet) return {id: 'test', revision: 1, digest: 'frozen', name: 'Flow', nodes: [], parameters, inputGroups};
        if (command === SessionCommand.GetConnections) return {connections: []};
        if (command === SessionCommand.CheckFlowConnections) return check();
        throw new Error('Unexpected command');
    });
    return {signal, execute, result: prepareAgentFlow({execute} as never, agent, signal.signal, {text, files: []})};
}
it('starts complete explicit run arguments without a dialog and still checks connections', async () => {
    const run = prepare([{name: 'lesson', type: 'string', required: true}, {name: 'count', type: 'number', default: 2, minimum: 1}]);
    expect((await run.result)?.flowParameters).toEqual({lesson: 'lesson', count: 2});
    expect(document.querySelector('dialog')).toBeNull();
    expect(run.execute).toHaveBeenCalledWith(SessionCommand.CheckFlowConnections, expect.objectContaining({parameters: {lesson: 'lesson', count: 2}}));
});
it('opens the form for missing inputs or a missing connection binding', async () => {
    for (const run of [prepare([{name: 'lesson', type: 'string'}, {name: 'required', type: 'number', required: true}]),
        prepare([{name: 'lesson', type: 'string'}], async () => {throw Object.assign(new Error('Choose a connection'), {code: 'FLOW_CONNECTION_BINDING_MISSING'});})]) {
        await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
        run.signal.abort(); expect(await run.result).toBeNull();
    }
});
it('does not hide network errors behind a confirmation form', async () => {
    const error = Object.assign(new Error('Network unavailable'), {code: 'EIO'});
    const run = prepare([{name: 'lesson', type: 'string'}], async () => {throw error;});
    await expect(run.result).rejects.toBe(error); expect(document.querySelector('dialog')).toBeNull();
});
it('uses exactly one supplied group member instead of retaining competing defaults', async () => {
    const run = prepare([{name: 'text', type: 'string', default: 'old'}, {name: 'json', type: 'json'}], undefined,
        '/run json={"value":1}', [{name: 'source', mode: 'oneOf', parameters: ['text', 'json']}]);
    expect((await run.result)?.flowParameters).toEqual({json: {value: 1}});
});
