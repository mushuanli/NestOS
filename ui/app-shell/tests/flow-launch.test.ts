import { createMindosFlowLibrary } from '@itookit/app-core';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand, SessionCommand } from '@itookit/llm-session';
import { FlowLauncher } from '../../llm-ui/src/flows/run-flow';
import { createFlowContextMenuConfig } from '../../llm-ui/src/flows/context-menu';
import { promptFlowParameters } from '../../llm-ui/src/components/FlowParameterForm';

const parameters = [
    { name: 'requirements', type: 'string' as const, required: true },
    { name: 'essay', type: 'string' as const, required: true },
];
function fixture() {
    const draft = { id: 'essay', name: 'Essay', draftVersion: 3, parameters };
    const revision = { ...draft, revision: 2 };
    const execute = vi.fn(async (command: string) => {
        if (command === SessionCommand.GetConnections) return { connections: [{ id: 'run-model', name: 'Run model', providerId: 'p' }] };
        if (command === FlowCommand.DraftLoad) return draft;
        if (command === FlowCommand.RevisionGet) return revision;
        if (command === FlowCommand.RevisionCreate) return { revision };
        if (command === SessionCommand.CreateFromFlow) return { sessionId: 'new-session' };
        throw new Error(command);
    });
    const navigate = vi.fn();
    return { execute, navigate, commands: { execute } as unknown as ICommandBus };
}
function submit() { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
function field(index: number) { return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-parameter="${index}"]`)!; }

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('Flow file launch', () => {
    it('offers Run only on .flow files and keeps existing menu actions', () => {
        const menu = createFlowContextMenuConfig(fixture());
        const defaults = [{ id: 'rename', label: 'Rename' }];
        expect(menu.items!({ id: '/essay.flow', type: 'file' }, defaults).map(item => item.id)).toContain('flow:run');
        expect(menu.items!({ id: '/essay.flow', type: 'directory' }, defaults)).toEqual(defaults);
        expect(menu.items!({ id: '/essay.md', type: 'file' }, defaults)).toEqual(defaults);
    });

    it('launches the saved file through parameters, revision, new Session and navigation', async () => {
        const f = fixture();
        const menu = createFlowContextMenuConfig(f);
        const node = { id: '/essay.flow', type: 'file' as const };
        const action = menu.items!(node, []).find(item => item.id === 'flow:run')!;
        const pending = action.onClick!(node);
        await vi.waitFor(() => expect(document.querySelector('dialog')).not.toBeNull());
        expect(f.execute).not.toHaveBeenCalledWith(SessionCommand.CreateFromFlow, expect.anything());
        document.querySelector<HTMLSelectElement>('[data-run-connection]')!.value = 'run-model';
        field(0).value = 'Write about spring'; field(1).value = 'My essay\nSecond paragraph'; submit();
        await pending;
        expect(f.execute).toHaveBeenCalledWith(FlowCommand.RevisionCreate, { draftId: 'essay', expectedDraftVersion: 3 });
        expect(f.execute).toHaveBeenCalledWith(SessionCommand.CreateFromFlow, {
            invocation: true, connectionId: 'run-model',
            flowId: 'essay', revision: 2, title: 'Essay', parameters: { requirements: 'Write about spring', essay: 'My essay\nSecond paragraph' },
        });
        expect(f.navigate).toHaveBeenCalledWith('new-session');
    });

    it('cancels without publishing or creating a Session', async () => {
        const f = fixture(); const launcher = new FlowLauncher({ ...f, prompt: async () => null });
        await launcher.run('essay');
        expect(f.execute.mock.calls.map(call => call[0])).toEqual([FlowCommand.DraftLoad, SessionCommand.GetConnections]);
        expect(f.navigate).not.toHaveBeenCalled();
    });

    it('does not create a Session when the draft changed while parameters were entered', async () => {
        const f = fixture();
        f.execute.mockImplementation(async command => {
            if (command === FlowCommand.DraftLoad) return { id: 'essay', name: 'Essay', draftVersion: 3, parameters };
            throw new Error('version conflict');
        });
        const launcher = new FlowLauncher({ ...f, prompt: async () => ({ essay: 'Text', requirements: 'Topic' }) });
        await expect(launcher.run('essay')).rejects.toThrow('version conflict');
        expect(f.execute.mock.calls.map(call => call[0])).not.toContain(SessionCommand.CreateFromFlow);
        expect(f.navigate).not.toHaveBeenCalled();
    });

    it('coalesces repeat clicks and reuses a published revision from the toolbar', async () => {
        const f = fixture();
        let answer!: (value: Record<string, string>) => void;
        const launcher = new FlowLauncher({ ...f, prompt: () => new Promise(resolve => { answer = resolve; }) });
        const first = launcher.run('essay', 2);
        await vi.waitFor(() => expect(answer).toBeDefined());
        await launcher.run('essay', 2);
        answer({ essay: 'Text', requirements: 'Topic' }); await first;
        expect(f.execute.mock.calls.map(call => call[0])).toEqual([FlowCommand.RevisionGet, SessionCommand.GetConnections, SessionCommand.CreateFromFlow]);
    });
});

describe('Flow parameter form', () => {
    it('keeps partial values after repeated validation failures and eventually resolves', async () => {
        const result = promptFlowParameters([...parameters, { name: 'options', type: 'json', required: true }]);
        submit(); expect(document.querySelector('dialog')!.open).toBe(true);
        field(0).value = 'Topic'; submit(); expect(field(0).value).toBe('Topic');
        field(1).value = 'Essay'; field(2).value = 'invalid'; submit();
        expect(document.querySelector('[data-form-error]')!.textContent).not.toBe('');
        field(2).value = '{"rounds":10}'; submit();
        expect(await result).toEqual({ requirements: 'Topic', essay: 'Essay', options: { rounds: 10 } });
        expect(document.querySelector('dialog')).toBeNull();
    });

    it('preserves false and zero defaults and omits unfilled optional numeric/JSON fields', async () => {
        const result = promptFlowParameters([
            { name: 'enabled', type: 'boolean', default: false, required: true },
            { name: 'limit', type: 'number', default: 0 },
            { name: 'optionalNumber', type: 'number' }, { name: 'optionalJson', type: 'json' },
        ]);
        submit(); expect(await result).toEqual({ enabled: false, limit: 0 });
    });

    it('supports cancellation after a validation error', async () => {
        const result = promptFlowParameters(parameters); submit();
        document.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
        expect(await result).toBeNull();
    });
});

describe('bundled Flow library', () => {
    it('installs missing templates without overwriting existing user drafts', async () => {
        const { installFlowLibrary } = await import('../../llm-ui/src/flows/library');
        const stored = new Map();
        const execute = vi.fn(async (command: string, args: any) => {
            if (command === FlowCommand.DraftInstall) {
                if (!stored.has(args.id)) stored.set(args.id, structuredClone(args));
                return stored.get(args.id);
            }
            throw new Error(command);
        });
        const commands = { execute } as unknown as ICommandBus;
        await installFlowLibrary(commands, createMindosFlowLibrary());
        const id = createMindosFlowLibrary()[0].id;
        expect(stored.get(id).parameters.find((param: any) => param.name === 'maxRounds').default).toBe(10);
        stored.get(id).name = 'User edited';
        execute.mockClear(); await installFlowLibrary(commands, createMindosFlowLibrary());
        expect(stored.get(id).name).toBe('User edited');
        expect(execute.mock.calls.map(call => call[0])).toEqual([FlowCommand.DraftInstall]);
    });

    it('rejects invalid templates before creating a file', async () => {
        const { installFlowLibrary } = await import('../../llm-ui/src/flows/library');
        const execute = vi.fn(async () => { throw new Error('Invalid graph'); });
        await expect(installFlowLibrary({ execute } as unknown as ICommandBus, createMindosFlowLibrary())).rejects.toThrow('Invalid graph');
        expect(execute).toHaveBeenCalledTimes(1);

    });
});

it('validates configurable round limits before closing the run form', async () => {
    const result = promptFlowParameters([{ name: 'maxRounds', type: 'number', default: 10,
        required: true, integer: true, minimum: 1, maximum: 1000 }]);
    expect(field(0).value).toBe('10');
    for (const invalid of ['0', '1.5', '1001']) {
        field(0).value = invalid; submit();
        expect(document.querySelector('dialog')!.open).toBe(true);
    }
    field(0).value = '2'; submit();
    expect(await result).toEqual({ maxRounds: 2 });
});

it('preserves editable parameter bounds and missing-input policy through Flow settings', async () => {
    const { openFlowSettings } = await import('../../llm-ui/src/components/dag/FlowSettingsDialog');
    const result = openFlowSettings({ connections: [], availableConnections: [], parameters: [
        { name: 'rounds', type: 'number', default: 10, required: true, minimum: 1, maximum: 1000, integer: true },
        { name: 'essay', type: 'string', required: true, onMissing: 'interact' },
    ] });
    document.querySelector<HTMLInputElement>('[data-param-max]')!.value = '20';
    const variables = { essay: { type: 'string', initial: '${param.essay}' } };
    document.querySelector<HTMLTextAreaElement>('[data-variables]')!.value = JSON.stringify(variables);
    const dialog = document.querySelector('dialog')!; dialog.returnValue = 'save'; dialog.close();
    const saved = await result;
    expect(saved?.variables).toEqual(variables);
    expect(saved?.parameters).toEqual([
        { name: 'rounds', type: 'number', default: 10, required: true, minimum: 1, maximum: 20, integer: true },
        { name: 'essay', type: 'string', required: true, onMissing: 'interact' },
    ]);
});

it('restores the builtin library from System Recovery without duplicate requests', async () => {
    const { RecoverySettingsEditor } = await import('../../app-settings/src/editors/RecoverySettingsEditor');
    const { Toast } = await import('@itookit/ui-common');
    const notice = vi.spyOn(Toast, 'success').mockImplementation(() => undefined);
    let finish!: (count: number) => void;
    const restore = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const root = document.createElement('div'); document.body.append(root);
    const editor = new RecoverySettingsEditor(root, { getRestorableItems: async () => [] } as never, {} as never, restore);
    try {
        await editor.init(root);
        const button = root.querySelector<HTMLButtonElement>('#btn-restore-flows')!;
        button.click(); button.click();
        expect(restore).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
        finish(1);
        await vi.waitFor(() => expect(button.disabled).toBe(false));
        expect(notice).toHaveBeenCalled();
    } finally { await editor.destroy(); }
});

it('offers explicit restore on the Flow directory and sends the dedicated restore command', async () => {
    const f = fixture();
    f.execute.mockImplementation(async command => {
        expect(command).toBe(FlowCommand.DraftRestore);
        return { id: 'restored' } as never;
    });
    const menu = createFlowContextMenuConfig({ ...f, library: createMindosFlowLibrary() });
    const directory = { id: '/@flows', type: 'directory' as const };
    const action = menu.items!(directory, []).find(item => 'id' in item && item.id === 'flow:restore');
    expect(action).toBeDefined();
    await (action as any).onClick(directory);
    expect(f.execute).toHaveBeenCalledTimes(1);
});

it('keeps parameter bindings editable in numeric node fields and supports multiline reviewer instructions', async () => {
    const { SchemaForm } = await import('../../llm-ui/src/components/dag/SchemaForm');
    const root = document.createElement('div'); document.body.append(root);
    const form = new SchemaForm(root, { type: 'object', properties: {
        maxRounds: { type: 'integer' }, instruction: { type: 'string', format: 'multiline' },
    } }, { maxRounds: '${params.maxRounds}', instruction: 'Check the essay\nExplain the score' });
    form.render();
    expect(form.read()).toEqual({ value: { maxRounds: '${params.maxRounds}', instruction: 'Check the essay\nExplain the score' }, errors: [] });
    expect(root.querySelector('textarea')?.value).toContain('\n');
    root.querySelector<HTMLInputElement>('input')!.value = '2';
    expect(form.read().value).toMatchObject({ maxRounds: 2 });
});

it('renders typed input widgets and waits for the durable response before closing', async () => {
    let finish!: () => void;
    const respond = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = promptFlowParameters([
        { name: 'essay', type: 'string', widget: 'textarea', required: true },
        { name: 'style', type: 'string', widget: 'select', options: ['narrative', 'argument'], required: true },
    ], 'Input', respond);
    field(0).value = 'Essay';
    document.querySelector<HTMLSelectElement>('[data-parameter="1"]')!.value = JSON.stringify('narrative');
    submit();
    expect(respond).toHaveBeenCalledWith({ essay: 'Essay', style: 'narrative' });
    expect(document.querySelector('dialog')).not.toBeNull();
    finish();
    expect(await pending).toEqual({ essay: 'Essay', style: 'narrative' });
});

it('closes an obsolete input form when its task attachment changes', async () => {
    const abort = new AbortController();
    const pending = promptFlowParameters([{ name: 'essay', type: 'string' }], 'Input', undefined, abort.signal);
    abort.abort();
    expect(await pending).toBeNull();
    expect(document.querySelector('dialog')).toBeNull();
});

it('inserts schema-derived score references into judge conditions and previews prompts without model calls', async () => {
    const { enhanceInvocationEditor } = await import('../../llm-ui/src/components/dag/InvocationEditor');
    const root = document.createElement('div'); document.body.append(root);
    root.innerHTML = '<textarea data-schema-path="$.condition"></textarea>';
    const route = { id: 'route', name: 'Route', plugin: 'builtin.route', config: { invocationDefaults: { prompt: 'Essay ${param.essay}', outputContract: { schema: { properties: { score: { type: 'number' } } } } } } };
    const check = { id: 'check', plugin: 'builtin.check', config: { key: 'content', systemPrompt: 'Content rubric' } };
    const draft = { nodes: [route, check], edges: [{ from: 'route', to: 'check' }], parameters: [{ name: 'essay', default: 'Sample' }] };
    enhanceInvocationEditor(root, draft as any, check as any);
    const field = root.querySelector('textarea')!; field.focus();
    const select = root.querySelector('select')!;
    select.value = '${state.results.content.value.score}'; select.dispatchEvent(new Event('change'));
    expect(field.value).toBe('${state.results.content.value.score}');
    root.querySelector<HTMLButtonElement>('[data-preview]')!.click();
    expect(root.querySelector('[data-prompt-preview]')!.textContent).toContain('Essay Sample');
    expect(root.textContent).toContain('Route');
});

it('edits input field names, types and widgets without retaining renamed fields', async () => {
    const { SchemaForm } = await import('../../llm-ui/src/components/dag/SchemaForm');
    const { enhanceInputFieldsEditor } = await import('../../llm-ui/src/components/dag/InputFieldsEditor');
    const root = document.createElement('div'); document.body.append(root);
    const config = { param: { essay: { type: 'string', widget: 'textarea', nonBlank: true } } };
    const form = new SchemaForm(root, { type: 'object', properties: { param: { type: 'object' } } }, config);
    form.render(); enhanceInputFieldsEditor(root, config);
    root.querySelector<HTMLInputElement>('[data-field="name"]')!.value = 'score';
    root.querySelector<HTMLSelectElement>('[data-field="type"]')!.value = 'number';
    root.querySelector<HTMLSelectElement>('[data-field="widget"]')!.value = 'number';
    root.querySelector<HTMLButtonElement>('[data-add-field]')!.click();
    const value = form.read().value as any;
    expect(value.param).not.toHaveProperty('essay');
    expect(value.param.score).toMatchObject({ type: 'number', widget: 'number' });
    expect(value.param.score).not.toHaveProperty('nonBlank');
    expect(value.param).toHaveProperty('field1');
});


it('does not offer template restoration without a host catalog', () => {
    const f = fixture();
    const menu = createFlowContextMenuConfig(f);
    expect(menu.items!({ id: '/@flows', type: 'directory' }, [])).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
});
