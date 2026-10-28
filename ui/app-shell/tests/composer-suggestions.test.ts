// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {ChatInput} from '../../llm-ui-adapter/src/components/input/ChatInputView';
import {resourceSuggestions} from '../../llm-ui-adapter/src/flows/resource-suggestions';

let view: ChatInput;
afterEach(() => {view?.destroy(); document.body.replaceChildren();});
function setup(flow = false) {
    const root = document.createElement('div'); document.body.append(root);
    const onRequestReferences = vi.fn(async () => [{name: 'essay.md', path: '@notes:/essay.md', reference: '@notes:/essay.md'}]);
    const onRequestFiles = vi.fn(async () => [{name: 'essay.md', path: './essay.md'}]);
    view = new ChatInput(root, {flowCommandSelectsTarget: true, onRequestReferences, onRequestFiles,
        initialConfig: flow ? {target: {kind: 'flow', id: 'review'}} : undefined, onSend() {}, onStop() {}});
    const input = root.querySelector<HTMLTextAreaElement>('.llm-input__textarea')!;
    const type = (value: string) => {input.value = value; input.selectionStart = value.length; input.dispatchEvent(new Event('input'));};
    const select = () => input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    return {input, type, select, onRequestReferences, onRequestFiles};
}
it('offers run and flow in a new composer without sending a command on selection', async () => {
    const {input, type, select} = setup(); type('/');
    await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('/run'));
    expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('/flow');
    select(); expect(input.value).toBe('/run ');
});
it('inserts a standard notes reference for a named Flow argument', async () => {
    const {input, type, select, onRequestReferences, onRequestFiles} = setup(true);
    type('/run requirements=@notes:/essay');
    await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('essay.md'));
    select(); expect(input.value).toBe('/run requirements=@notes:/essay.md');
    expect(onRequestReferences).toHaveBeenCalledWith('notes:/essay', {includeIgnored: false}); expect(onRequestFiles).not.toHaveBeenCalled();
});
it('keeps normal chat attachments as Markdown links', async () => {
    const {input, type, select, onRequestReferences} = setup(); type('@essay');
    await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('essay.md'));
    select(); expect(input.value).toBe('[essay.md](./essay.md)'); expect(onRequestReferences).not.toHaveBeenCalled();
});
it('reports a resource search failure and preserves the composer', async () => {
    const {input, type, onRequestReferences} = setup(true);
    onRequestReferences.mockRejectedValueOnce(new Error('Project is offline'));
    type('/run @//demo/');
    await vi.waitFor(() => expect(document.querySelector('.llm-popup--visible')?.textContent).toContain('Project is offline'));
    expect(input.value).toBe('/run @//demo/');
});
it('keeps project scope in draft discovery and omits navigation shortcuts from chat attachments', async () => {
    const execute = vi.fn(async () => [{label: 'notes:/', reference: '@notes:/'}, {label: '//', reference: '@//'}, {label: '/photo.png', reference: '@/photo.png'}]);
    const entries = await resourceSuggestions({execute} as never, {navigation: 'projects', projectId: 'project'}, '', false);
    expect(execute).toHaveBeenCalledWith('app.resource.search', {query: '', scope: {navigation: 'projects', projectId: 'project'}});
    expect(entries).toEqual([{name: '/photo.png', path: './photo.png', mimeType: 'image/png'}]);
});
