// @vitest-environment jsdom
import {beforeEach, expect, it, vi} from 'vitest';
import {ResourceCommand} from '@itookit/app-contracts';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {promptFlowParameters} from '../components/FlowParameterForm';
import {prepareAgentFlow} from './agent-flow';

vi.mock('./connection-selection', () => ({flowConnectionSelection: vi.fn(async () => ({bindings: {}}))}));
vi.mock('../components/FlowParameterForm', async original => ({...await original<typeof import('../components/FlowParameterForm')>(),
    promptFlowParameters: vi.fn(async (fields: {name: string; default?: unknown}[]) => Object.fromEntries(fields.map(field => [field.name, field.default])))}));
beforeEach(() => {vi.clearAllMocks();});
function fixture() {
    const flow = {id: 'flow', revision: 1, digest: 'published', parameters: [{name: 'request', type: 'string', required: true, inputSource: 'composer.text'}]};
    const execute = vi.fn(async (name: string) => {
        if (name === FlowCommand.RevisionGet) return flow;
        if (name === ResourceCommand.Read) return {kind: 'text', text: 'File contents', bytes: 13};
        throw new Error('Unexpected command');
    });
    const agent = {id: 'agent', name: 'Flow Agent', execution: {kind: 'flow', flowId: 'flow', revision: 1}};
    return {execute, agent, prepare: (text: string) => prepareAgentFlow({execute} as never, agent as never, new AbortController().signal,
        {text, files: [], sourceScope: {navigation: 'projects', projectId: 'project'}})};
}
it('opens the existing form with composer text and expanded file content instead of a JSON editor', async () => {
    const f = fixture(); expect((await f.prepare('Summarize @/document.md'))?.flowParameters).toEqual({request: 'Summarize File contents'});
    expect(vi.mocked(promptFlowParameters).mock.calls[0][0][0].default).toBe('Summarize File contents');
    expect(f.execute.mock.calls.filter(([name]) => name === ResourceCommand.Read)).toHaveLength(1);
});
it('uses the existing slash argument path and starts complete arguments without opening the form', async () => {
    const f = fixture(); expect((await f.prepare('/run request=@/document.md'))?.flowParameters).toEqual({request: 'File contents'});
    expect(promptFlowParameters).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.filter(([name]) => name === ResourceCommand.Read)).toHaveLength(1);
});
it('does not open or submit a form after a referenced file cannot be read', async () => {
    const f = fixture(), original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async name => {if (name === ResourceCommand.Read) throw Object.assign(new Error('Missing file'), {code: 'ENOENT'}); return original(name);});
    await expect(f.prepare('Read @/missing.md')).rejects.toMatchObject({code: 'ENOENT'});
    expect(promptFlowParameters).not.toHaveBeenCalled();
});
