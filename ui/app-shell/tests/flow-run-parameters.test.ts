// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { FlowCommand, type FlowConnection, type FlowInputGroup, type FlowParameter } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { FlowsEditor } from '../../llm-ui-adapter/src/components/FlowsEditor';
import { DagWorkbench } from '../../llm-ui-adapter/src/components/DagWorkbench';
import { NAVIGATION_EVENTS } from '@itookit/common';
import { InputAssetCommand } from '@itookit/app-contracts';
import { FlowRunParameters } from '../../llm-ui-adapter/src/components/dag/FlowRunParameters';
import {promptFlowParameters, type FlowConnectionSelection} from '../../llm-ui-adapter/src/components/FlowParameterForm';

const draft = {
    id: 'sample', name: 'Sample', draftVersion: 1, layout: {}, edges: [],
    nodes: [{ id: 'node', name: 'Test node', plugin: 'test', pluginVersion: '1.0.0', inputs: {}, config: {} }],
    parameters: [{ name: 'essay', label: '文章内容', type: 'string', required: true },
        { name: 'enabled', type: 'boolean', default: false }, { name: 'limit', type: 'number', default: 0 }],
    connections: [{ name: 'analysis', description: '文本生成' }],
};
const connections = [{ id: 'model', name: 'Model', providerId: 'provider', credentialsReady: true }];
const editors: Array<{ destroy(): unknown }> = [];

async function setup() {
    const execute = vi.fn(async (name: string, args?: any): Promise<any> => {
        if (name === FlowCommand.Presentations) return [];
        if (name === FlowCommand.SourceCheck) return { valid: true, diagnostics: [] };
        if (name === FlowCommand.DraftLoad) return draft;
        if (name === SessionCommand.GetConnections) return { connections };
        if (name === SessionCommand.CheckFlowConnections) {
            if (!args?.connectionBindings?.analysis) throw Object.assign(new Error('请选择模型连接：文本生成'), {field: 'analysis'});
            return {valid: true};
        }
        if (name === FlowCommand.DraftSave) return { draft: { ...args.draft, draftVersion: 2 } };
        if (name === FlowCommand.RevisionCreate) return { revision: { ...draft, draftVersion: 2, revision: 3 } };
        if (name === FlowCommand.RevisionGet) return { ...draft, revision: 3 };
        if (name === SessionCommand.CreateFromFlow) return { sessionId: 'created' };
        throw new Error(name);
    });
    const root = document.createElement('div'); document.body.append(root);
    const editor = new FlowsEditor({ commands: { execute } as never }, '/sample.flow');
    editors.push(editor);
    await editor.init(root);
    await vi.waitFor(() => expect(root.querySelector('[data-parameter="0"]')).not.toBeNull());
    const run = () => root.querySelector<HTMLButtonElement>('[data-action="run"]')!.click();
    const field = () => root.querySelector<HTMLTextAreaElement>('[data-parameter="0"]')!;
    const slot = () => root.querySelector<HTMLSelectElement>('[data-slot-connection="0"]')!;
    return { execute, root, editor, run, field, slot };
}

afterEach(async () => {
    for (const editor of editors.splice(0)) await editor.destroy();
    document.body.replaceChildren(); vi.restoreAllMocks();
});

it('runs from the right panel with validated parameters and connections without opening a dialog', async () => {
    const f = await setup(), navigate = vi.fn();
    f.root.addEventListener(NAVIGATION_EVENTS.NAVIGATE, navigate);
    expect(f.root.querySelector('.dag-run-parameters')?.closest('aside')).not.toBeNull();
    expect(f.root.querySelector('.dag-inspector__tabs [data-action="run"]')).not.toBeNull();
    expect(f.root.querySelector('.dag-toolbar [data-action="run"]')).toBeNull();
    f.run();
    await vi.waitFor(() => expect(f.root.querySelector('[data-form-error]')?.textContent).toBe('请填写 文章内容'));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.DraftSave)).toBe(false);
    f.field().value = 'My essay'; f.run();
    await vi.waitFor(() => expect(f.root.querySelector('[data-form-error]')?.textContent).toBe('请选择模型连接：文本生成'));
    f.slot().value = 'model'; f.run(); f.run();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(f.execute).toHaveBeenCalledWith(SessionCommand.CreateFromFlow, {
        flowId: 'sample', revision: 3, title: 'Sample', invocation: true, connectionId: undefined,
        parameters: { essay: 'My essay', enabled: false, limit: 0 }, connectionBindings: { analysis: 'model' },
    });
    expect(f.execute.mock.calls.filter(([name]) => name === SessionCommand.CreateFromFlow)).toHaveLength(1);
    expect(document.querySelector('dialog')).toBeNull();
});

it('checks model capabilities before saving and retains input when admission fails', async () => {
    const f = await setup(), previous = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, args) => {
        if (name === SessionCommand.CheckFlowConnections) throw Object.assign(new Error('Connection slot analysis: image input is unsupported'), {field: 'analysis'});
        return previous(name, args);
    });
    f.field().value = 'Keep this'; f.slot().value = 'model';
    const panel = f.root.querySelector<HTMLElement>('.dag-run-parameters')!; panel.scrollTop = 100;
    f.run();
    await vi.waitFor(() => expect(f.root.querySelector('[data-form-error]')?.textContent).toContain('image input'));
    expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.DraftSave || name === SessionCommand.CreateFromFlow)).toBe(false);
    expect(f.field().value).toBe('Keep this'); expect(panel.scrollTop).toBe(0);
});

it('keeps the form DOM and input when selecting nodes, editing connections, and redrawing the canvas', async () => {
    const f = await setup(), original = f.field();
    original.value = 'Keep this'; f.slot().value = 'model';
    f.root.querySelector<HTMLElement>('[data-flow-node="node"]')!.click();
    expect(f.field()).toBe(original);
    expect(f.root.querySelector<HTMLButtonElement>('[data-inspector-tab="parameters"]')!.getAttribute('aria-pressed')).toBe('true');
    f.root.querySelector<HTMLButtonElement>('[data-inspector-tab="edit"]')!.click();
    expect(f.root.querySelector<HTMLElement>('.dag-run-parameters')!.hidden).toBe(true);
    f.root.querySelector<HTMLButtonElement>('[data-inspector-tab="parameters"]')!.click();
    f.root.querySelector<HTMLButtonElement>('[data-action="zoom-in"]')!.click();
    expect(f.field()).toBe(original); expect(f.field().value).toBe('Keep this'); expect(f.slot().value).toBe('model');
    expect(f.execute.mock.calls.filter(([name]) => name === SessionCommand.GetConnections)).toHaveLength(1);
});

it('shows launch failures in the panel and keeps the entered values for retry', async () => {
    const f = await setup(), previous = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (name, args) => {
        if (name === SessionCommand.CreateFromFlow) throw new Error('launch denied');
        return previous(name, args);
    });
    f.field().value = 'Retry me'; f.slot().value = 'model'; f.run();
    await vi.waitFor(() => expect(f.root.querySelector('[data-form-error]')?.textContent).toContain('launch denied'));
    expect(f.field().value).toBe('Retry me'); expect(f.slot().value).toBe('model');
    expect(f.root.querySelector<HTMLButtonElement>('[data-action="run"]')!.disabled).toBe(false);
    f.execute.mockImplementation(previous); f.run();
    await vi.waitFor(() => expect(f.execute.mock.calls.filter(([name]) => name === SessionCommand.CreateFromFlow)).toHaveLength(2));
    expect(document.querySelector('dialog')).toBeNull();
});

it.each([FlowCommand.DraftSave, FlowCommand.RevisionGet])('does not launch after the editor is closed during %s', async command => {
    const f = await setup(), previous = f.execute.getMockImplementation()!;
    let finish!: (value: any) => void;
    f.execute.mockImplementation(async (name, args) => name === command
        ? new Promise(resolve => { finish = resolve; }) : previous(name, args));
    f.field().value = 'Text'; f.slot().value = 'model'; f.run();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.editor.destroy(); finish(command === FlowCommand.DraftSave
        ? { draft: { ...draft, draftVersion: 2 } } : { ...draft, revision: 3 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.execute.mock.calls.some(([name]) => name === SessionCommand.CreateFromFlow)).toBe(false);
    if (command === FlowCommand.DraftSave) expect(f.execute.mock.calls.some(([name]) => name === FlowCommand.RevisionCreate)).toBe(false);
    expect(f.root.children).toHaveLength(0);
});

it('allows retrying connection loading and discards late results after a different draft is selected', async () => {
    let finish!: (value: any) => void, attempts = 0;
    const execute = vi.fn(async (name: string): Promise<any> => {
        if (name === FlowCommand.Presentations) return [];
        if (name === FlowCommand.SourceCheck) return { valid: true, diagnostics: [] };
        if (name === SessionCommand.GetConnections) {
            if (++attempts === 1) throw new Error('load failed');
            if (attempts === 2) return new Promise(resolve => { finish = resolve; });
            return { connections };
        }
    });
    const root = document.createElement('div'); document.body.append(root);
    const workbench = new DagWorkbench(root, { commands: { execute } as never }); editors.push(workbench);
    await workbench.initialize(); workbench.setDraft(draft as never);
    await vi.waitFor(() => expect(root.querySelector('[data-form-error]')?.textContent).toContain('load failed'));
    root.querySelector<HTMLButtonElement>('[data-retry]')!.click();
    workbench.setDraft({ ...draft, id: 'other', parameters: [{ name: 'other', type: 'string', default: 'New' }] } as never);
    await vi.waitFor(() => expect(root.querySelector('[name="other"]')).not.toBeNull());
    finish({ connections: [] }); await Promise.resolve();
    expect(root.querySelector('[name="essay"]')).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('[name="other"]')!.value).toBe('New');
});

it('waits for image staging in the inline panel and returns durable image references', async () => {
    const asset = { kind: 'input', id: '11111111-1111-4111-8111-111111111111', mimeType: 'image/png', bytes: 7, sha256: 'a'.repeat(64) };
    let imported!: (value: unknown) => void;
    const execute = vi.fn(async (name: string): Promise<any> => {
        if (name === SessionCommand.GetConnections) return { connections };
        if (name === InputAssetCommand.Import) return new Promise(resolve => { imported = resolve; });
        if (name === InputAssetCommand.Read) return 'data:image/png;base64,cGljdHVyZQ==';
    });
    const panel = new FlowRunParameters({ ...draft, connections: [], parameters: [
        { name: 'images', type: 'json', widget: 'images', required: true },
    ] } as never, { execute } as never);
    document.body.append(panel.root); editors.push(panel);
    await vi.waitFor(() => expect(panel.root.querySelector('[data-image-picker]')).not.toBeNull());
    const picker = panel.root.querySelector<HTMLInputElement>('[data-image-picker]')!;
    Object.defineProperty(picker, 'files', { value: [new File(['picture'], 'page.png', { type: 'image/png' })] });
    picker.dispatchEvent(new Event('change'));
    const result = panel.read(), settled = vi.fn(); void result.then(settled);
    await vi.waitFor(() => expect(imported).toBeDefined()); expect(settled).not.toHaveBeenCalled();
    imported(asset);
    const input = await result;
    expect(input?.parameters).toEqual({ images: [{ type: 'image', source: { type: 'asset', asset } }] });
    await vi.waitFor(() => expect(panel.root.querySelectorAll('[data-image-preview] img')).toHaveLength(1));
    panel.destroy(); expect(input?.signal?.aborted).toBe(true);
});

function prompt(parameters: FlowParameter[], slots: FlowConnection[] = [], groups?: FlowInputGroup[]) {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function () {this.open = true;});
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function () {this.open = false; this.dispatchEvent(new Event('close'));});
    const validate = vi.fn(async (_values?: Record<string, unknown>) => {});
    const connection: FlowConnectionSelection = {connections, slots, onChange: id => {connection.selected = id;}, validate};
    const result = promptFlowParameters(parameters, 'Prepare a run', undefined, undefined, connection, undefined, undefined, {inputGroups: groups});
    const dialog = document.querySelector<HTMLDialogElement>('.flow-parameter-dialog')!;
    const submit = () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));
    return {dialog, result, connection, validate, submit};
}

it('updates required connection labels from current inputs and focuses the missing connection', async () => {
    const f = prompt([{name: 'essay', label: '文章内容', type: 'string', required: true, default: 'Keep this input'},
        {name: 'pictures', label: '图片', type: 'json', widget: 'images'}, {name: 'illustrate', type: 'boolean', default: false}], [
        {name: 'analysis', label: '文本生成'},
        {name: 'vision', label: '图片识别', requiredWhen: {kind: 'exists', args: [{kind: 'param', path: ['pictures', '0']}]}},
        {name: 'illustration', label: '插图生成', requiredWhen: {kind: 'eq', args: [{kind: 'param', path: ['illustrate']}, {kind: 'literal', value: true}]}},
    ]);
    const rows = f.dialog.querySelectorAll('[data-slot-requirement]');
    expect([...rows].map(row => row.textContent)).toEqual(['必选', '可选', '可选']);
    const image = f.dialog.querySelector<HTMLTextAreaElement>('[name="pictures"]')!;
    image.value = '[{"type":"image_url","image_url":{"url":"data:image/png;base64,cGljdHVyZQ=="}}]';
    image.dispatchEvent(new Event('input', {bubbles: true})); expect(rows[1].textContent).toBe('必选');
    image.value = ''; image.dispatchEvent(new Event('input', {bubbles: true})); expect(rows[1].textContent).toBe('可选');
    f.dialog.querySelector<HTMLSelectElement>('[data-slot-connection="0"]')!.value = 'model';
    const enabled = f.dialog.querySelector<HTMLInputElement>('[name="illustrate"]')!; enabled.click();
    expect(rows[2].textContent).toBe('必选');
    f.validate.mockRejectedValueOnce(Object.assign(new Error('请选择模型连接：插图生成'), {field: 'illustration'})); f.submit();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-form-error]')!.textContent).toBe('请选择模型连接：插图生成'));
    const required = f.dialog.querySelector<HTMLSelectElement>('[data-slot-connection="2"]')!;
    expect(document.activeElement).toBe(required); expect(required.getAttribute('aria-invalid')).toBe('true');
    expect(f.dialog.querySelector<HTMLTextAreaElement>('[name="essay"]')!.value).toBe('Keep this input');
    required.value = 'model'; required.dispatchEvent(new Event('change', {bubbles: true})); f.submit();
    await expect(f.result).resolves.toEqual({essay: 'Keep this input', illustrate: true});
    expect(f.validate).toHaveBeenCalledWith({essay: 'Keep this input', illustrate: true});
    expect(f.connection.bindings).toEqual({analysis: 'model', illustration: 'model'});
});

it('requires an explicit declared input source and retains both drafts while submitting only the selected one', async () => {
    const f = prompt([{name: 'text', label: '文字', type: 'string', default: 'Existing text'},
        {name: 'images', label: '图片', type: 'json', widget: 'images', default: [{type: 'image_url', image_url: {url: 'data:image/png;base64,cGljdHVyZQ=='}}]}],
        [], [{name: 'content', label: '内容来源', mode: 'oneOf', parameters: ['text', 'images']}]);
    f.submit();
    await vi.waitFor(() => expect(f.dialog.querySelector('[data-form-error]')!.textContent).toBe('请选择 内容来源 的输入方式'));
    const text = f.dialog.querySelector<HTMLTextAreaElement>('[name="text"]')!, images = f.dialog.querySelector<HTMLTextAreaElement>('[name="images"]')!;
    const textChoice = f.dialog.querySelector<HTMLInputElement>('[data-flow-source="text"]')!;
    f.dialog.querySelector<HTMLInputElement>('[data-flow-source="images"]')!.click();
    expect(text.closest<HTMLElement>('[data-parameter-row]')!.hidden).toBe(true);
    textChoice.click(); expect(text.closest<HTMLElement>('[data-parameter-row]')!.hidden).toBe(false);
    expect(images.closest<HTMLElement>('[data-parameter-row]')!.hidden).toBe(true);
    expect(text.value).toBe('Existing text'); expect(images.value).toContain('image_url');
    images.value = 'Invalid unused JSON'; f.submit();
    await expect(f.result).resolves.toEqual({text: 'Existing text'});
});

it('places backend slot capability errors next to the connection without clearing inputs', async () => {
    const f = prompt([{name: 'essay', type: 'string', default: 'Keep this'}], [{name: 'vision', label: '图片识别'}]);
    const field = f.dialog.querySelector<HTMLSelectElement>('[data-slot-connection="0"]')!; field.value = 'model';
    f.validate.mockRejectedValueOnce(Object.assign(new Error('所选模型不支持图片输入'), {field: 'vision'})); f.submit();
    await vi.waitFor(() => expect(f.dialog.querySelector('.flow-parameter-field__error')!.textContent).toContain('所选模型不支持图片输入'));
    expect(document.activeElement).toBe(field); expect(f.dialog.open).toBe(true); expect(field.value).toBe('model');
    expect(f.dialog.querySelector<HTMLTextAreaElement>('[name="essay"]')!.value).toBe('Keep this');
    f.dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); await expect(f.result).resolves.toBeNull();
});

it('lets backend admission resolve an unbound required slot from purpose defaults', async () => {
    const f = prompt([], [{name: 'vision', required: true, requirements: {operation: 'chat', inputModalities: ['text', 'image']}}]);
    f.submit(); await expect(f.result).resolves.toEqual({});
    expect(f.validate).toHaveBeenCalledWith({}); expect(f.connection.bindings).toEqual({});
});

it('keeps an explicit optional unbinding while allowing required bindings to inherit', async () => {
    const f = prompt([], [{name: 'text', required: true, connectionId: 'model'}, {name: 'media', required: false, connectionId: 'model'}]);
    f.dialog.querySelectorAll<HTMLSelectElement>('[data-slot-connection]').forEach(field => {field.value = '';});
    f.submit(); await expect(f.result).resolves.toEqual({});
    expect(f.connection.bindings).toEqual({media: ''});
});
