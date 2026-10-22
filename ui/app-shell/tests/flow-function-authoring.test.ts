// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createBuiltinDagPluginRegistry } from '@itookit/llm-flow';
import { FlowCommand, type FlowDraft, type JsonValue } from '@itookit/llm-flow/contracts';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { DagWorkbench } from '../../llm-ui-adapter/src/components/DagWorkbench';
import { DagDraftController } from '../../llm-ui-adapter/src/components/dag/DagDraftController';

const workbenches: DagWorkbench[] = [];
afterEach(() => { for (const workbench of workbenches.splice(0)) workbench.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const signature = (id: string) => ({ id, name: id, parameters: [{ name: 'text', type: 'string', required: true },
    { name: 'tone', type: 'string' }], outputs: { response: { value: 'ok' }, score: { value: 1 } } } as unknown as FlowDraft);

async function setup(config: Record<string, JsonValue>, functions: FlowDraft[] = []) {
    const plugins = createBuiltinDagPluginRegistry(), manifest = plugins.getManifest('builtin.flow', '2.0.0')!;
    const ui = await plugins.loadUI(manifest.id, manifest.version);
    const execute = vi.fn(async (name: string, args?: any): Promise<any> => {
        if (name === FlowCommand.Presentations) return [{ manifest, ui }];
        if (name === FlowCommand.DraftList) return ['child', 'alternate'].map(signature);
        if (name === FlowCommand.RevisionGet) return signature(args.id);
        if (name === FlowCommand.SourceCheck) return { valid: true, diagnostics: [] };
        if (name === FlowCommand.DraftSave) return { draft: { ...args.draft, draftVersion: 2 } };
        if (name === SessionCommand.GetConnections) return { connections: [] };
        throw new Error(name);
    });
    const root = document.createElement('div'); document.body.append(root);
    const workbench = new DagWorkbench(root, { commands: { execute } as never }); workbenches.push(workbench);
    await workbench.initialize();
    workbench.setDraft({ id: 'parent', name: 'Parent', draftVersion: 1, layout: {}, edges: [], functions, nodes: [
        { id: 'invoke', name: 'Invoke', plugin: manifest.id, pluginVersion: manifest.version, inputs: {}, config },
    ] } as unknown as FlowDraft, 'invoke' as never);
    if (!functions.some(flow => flow.id === 'child')) {
        await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(FlowCommand.RevisionGet, { id: 'child', revision: undefined }));
    }
    return { root, execute };
}

it('shows named outputs for one call and an ordered result array port for parameter sets', async () => {
    const single = await setup({ flowId: 'child', parameters: { text: 'One' } });
    await vi.waitFor(() => expect(single.root.querySelector('.dag-node__ports')?.textContent).toContain('Out response, score'));
    const batch = await setup({ flowId: 'child', parameterSets: [{ text: 'One' }, { text: 'Two' }] });
    await vi.waitFor(() => expect(batch.root.querySelector('.dag-node__ports')?.textContent).toContain('Out result'));
    expect(batch.root.querySelector('.dag-node__ports')?.textContent).not.toContain('response');
});

it.each([{ parameterSets: [{ text: 'One' }, { text: 'Two' }] }, { parameterSets: '${param.groups}' }])(
    'keeps parameter sets, shared arguments and concurrency through signature changes and save ($parameterSets)', async ({ parameterSets }) => {
        const { root, execute } = await setup({ flowId: 'child', parameters: { tone: 'concise' }, parameterSets, maxConcurrency: 2 });
        root.querySelector<HTMLButtonElement>('[data-inspector-tab="edit"]')!.click();
        const field = (path: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-schema-path="$.${path}"]`)!;
        await vi.waitFor(() => expect(field('parameterSets')).not.toBeNull());
        expect(field('parameterSets').value).toBe(typeof parameterSets === 'string' ? parameterSets : JSON.stringify(parameterSets, null, 2));
        const previous = field('parameterSets');
        field('maxConcurrency').value = '3';
        field('flowId').value = JSON.stringify('alternate');
        field('flowId').dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(field('parameterSets')).not.toBe(previous));
        root.querySelector<HTMLButtonElement>('[data-node-action="save"]')!.click();
        root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
        await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(FlowCommand.DraftSave, expect.objectContaining({
            draft: expect.objectContaining({ nodes: [expect.objectContaining({ config: expect.objectContaining({
                flowId: 'alternate', parameters: { tone: 'concise' }, parameterSets, maxConcurrency: 3,
            }) })] }),
        })));
    },
);

function inlineFunctions(): FlowDraft[] {
    const nested = { ...signature('nested'), layout: {}, draftVersion: 1, updatedAt: 0, nodes: [], edges: [] };
    return ['child', 'local-only'].map(id => ({ ...nested, id, functions: [nested],
        parameters: [{ name: 'localText', type: 'string' }], outputs: { localResult: { value: 'local' } },
    } as FlowDraft));
}

it.each([false, true])('uses inline signatures before global definitions and preserves their whole table on save (batch=%s)', async batch => {
    const functions = inlineFunctions();
    const config: Record<string, JsonValue> = { flowId: 'child', parameters: { localText: 'One' },
        ...(batch ? { parameterSets: [{ localText: 'One' }], maxConcurrency: 1 } : {}) };
    const { root, execute } = await setup(config, functions);
    expect(root.querySelector('.dag-node__ports')?.textContent).toContain(batch ? 'Out result' : 'Out localResult');
    expect(execute.mock.calls.some(([name]) => name === FlowCommand.RevisionGet)).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-inspector-tab="edit"]')!.click();
    const field = (path: string) => root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-schema-path="$.${path}"]`)!;
    await vi.waitFor(() => expect(field('parameters.localText')).not.toBeNull());
    expect(field('parameters.text')).toBeNull();
    const ids = [...(field('flowId') as HTMLSelectElement).options].map(option => option.value);
    expect(ids.filter(id => id === '"child"')).toHaveLength(1); expect(ids).toContain('"local-only"'); expect(ids).toContain('"alternate"');
    const previous = field('parameters.localText');
    field('flowId').value = '"local-only"'; field('flowId').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(field('parameters.localText')).not.toBe(previous));
    field('parameters.localText').value = 'Edited';
    root.querySelector<HTMLButtonElement>('[data-node-action="save"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="save"]')!.click();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(FlowCommand.DraftSave, expect.objectContaining({
        draft: expect.objectContaining({ functions, nodes: [expect.objectContaining({ config: expect.objectContaining({
            ...config, flowId: 'local-only', parameters: { localText: 'Edited' },
        }) })] }),
    })));
    expect(root.querySelector('.dag-node__ports')?.textContent).toContain(batch ? 'Out result' : 'Out localResult');
});

it('retains nested inline functions through draft edits, undo, redo and replacement', () => {
    const functions = inlineFunctions(), draft = { ...signature('parent'), functions, layout: {}, draftVersion: 1, updatedAt: 0,
        nodes: [], edges: [] } as FlowDraft;
    const controller = new DagDraftController(draft);
    controller.updateFlowSettings({ parameters: [{ name: 'entry', type: 'string' }] });
    expect(controller.value.functions).toEqual(functions);
    expect(controller.undo()).toBe(true); expect(controller.value.functions).toEqual(functions);
    expect(controller.redo()).toBe(true); expect(controller.value.functions).toEqual(functions);
    controller.replace({ ...controller.value, name: 'Saved parent' });
    const copy = controller.value; copy.functions![0].functions![0].name = 'Changed copy';
    expect(controller.value.functions).toEqual(functions);
});
