// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createMDxEditor} from '@itookit/mdx-adapter';
import {FlowDocuments, flowRequestMarkdown} from '../../llm-ui-adapter/src/components/dag/FlowDocuments';
import {FlowCallDocument} from '../../llm-ui-adapter/src/components/dag/FlowCallDocument';
vi.mock('@itookit/mdx-adapter', () => ({createMDxEditor: vi.fn(async (root: HTMLElement, options: {initialContent: string}) => {
    root.textContent = options.initialContent;
    return {on: vi.fn(), destroy: vi.fn(), setText: vi.fn((text: string) => {root.textContent = text;}), getText: () => root.textContent,
        finishStreamingText: vi.fn(async (text: string) => {root.textContent = text;})};
})}));
afterEach(() => {document.body.replaceChildren(); vi.clearAllMocks();});

it('defers long node editors and keeps each node editor and expansion across refreshes', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const documents = new FlowDocuments(), long = 'x'.repeat(6000);
    documents.mount(root, 'node-a', 'A', long); documents.mount(root, 'node-b', 'B', 'short');
    await vi.waitFor(() => expect(createMDxEditor).toHaveBeenCalledTimes(1));
    const a = root.querySelector('details')!; expect(a.open).toBe(false);
    a.open = true; a.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(createMDxEditor).toHaveBeenCalledTimes(2));
    const body = a.querySelector('div'); root.replaceChildren();
    documents.mount(root, 'node-a', 'A', long + ' updated');
    expect(root.querySelector('details')).toBe(a); expect(a.open).toBe(true); expect(a.querySelector('div')).toBe(body);
    expect(body?.textContent).toContain('updated'); expect(createMDxEditor).toHaveBeenCalledTimes(2);
    documents.retain(new Set(['node-a'])); documents.destroy();
    const editors = await Promise.all(vi.mocked(createMDxEditor).mock.results.map(result => result.value));
    await vi.waitFor(() => editors.forEach(editor => expect(editor.destroy).toHaveBeenCalledOnce()));
});

it('preserves literal request delimiters and disposes late editor initialization', async () => {
    expect(flowRequestMarkdown({text: '```\n<script>x</script>'})).toMatch(/^````json/);
    let ready!: (editor: any) => void;
    vi.mocked(createMDxEditor).mockImplementationOnce(() => new Promise(resolve => {ready = resolve;}) as never);
    const documents = new FlowDocuments(), root = document.createElement('div'); document.body.append(root);
    documents.mount(root, 'a', 'A', 'request'); await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    documents.destroy(); const editor = {destroy: vi.fn()}; ready(editor);
    await vi.waitFor(() => expect(editor.destroy).toHaveBeenCalledOnce()); expect(root.textContent).toBe('');
});

it('loads the final result of a called Flow once and exposes a separate detail action', async () => {
    const execute = vi.fn(async () => ({root: {task: {id: 'run', sessionId: 'child', output: {nodes: {
        __flow_return: {outputs: {answer: {outputName: 'answer', type: 'text', content: 'Final **answer**'}}},
        internal: {outputs: {result: 'internal trace'}},
    }}}}}));
    const call = {input: {request: {source: {kind: 'arguments', value: {question: 'Request'}}}}, status: 'completed', summary: 'Preview',
        receipt: {operationId: 'op', executionSessionId: 'child', execution: {taskId: 'run'}}} as any;
    const root = document.createElement('div'); document.body.append(root);
    const view = new FlowCallDocument(root, {execute} as any); view.update(call);
    await vi.waitFor(() => expect(root.textContent).toContain('Final **answer**'));
    expect(root.textContent).toContain('Request'); expect(root.textContent).not.toContain('internal trace');
    expect(root.querySelector('button')?.hidden).toBe(false); view.update(call); expect(execute).toHaveBeenCalledTimes(1);
    view.destroy();
});

it('rejects a result from another session and ignores a response after closing', async () => {
    const call = {input: {request: {source: {kind: 'arguments', value: {}}}}, status: 'completed', summary: 'Preview',
        receipt: {operationId: 'op', executionSessionId: 'child', execution: {taskId: 'run'}}} as any;
    const root = document.createElement('div'); document.body.append(root);
    let finish!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new FlowCallDocument(root, {execute} as any); view.update(call);
    finish({root: {task: {id: 'run', sessionId: 'foreign', output: 'private foreign result'}}});
    await vi.waitFor(() => expect(root.textContent).toContain('Preview'));
    expect(root.textContent).not.toContain('private foreign result');
    view.update(call); view.destroy(); finish({root: {task: {id: 'run', sessionId: 'child', output: 'late result'}}});
    await Promise.resolve(); expect(document.body.textContent).toBe('');
});
