// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {FlowDefinitionStore, type FlowStore} from '@itookit/llm-flow';
import {FlowCommand} from '@itookit/llm-flow/contracts';
import {FlowsEditor} from '../../llm-ui-adapter/src/components/FlowsEditor';
import {DagWorkbench} from '../../llm-ui-adapter/src/components/DagWorkbench';

const calendar = {id: 'collection-a', name: 'Collection', draftVersion: 1, updatedAt: 0, layout: {}, edges: [],
    nodes: [{id: 'collect', name: 'Collect', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, config: {toolId: 'fixture.collect', toolVersion: '1', args: {}}}]};
const gmail = {...calendar, id: 'collection-b'};
const editors: FlowsEditor[] = [];
afterEach(async () => {for (const editor of editors.splice(0)) await editor.destroy(); vi.restoreAllMocks(); document.body.replaceChildren();});

it.each([calendar, gmail])('renders an already saved $id without layout through the real draft loader', async template => {
    const {layout: _layout, ...legacy} = template;
    const source = JSON.stringify(legacy);
    const store = new FlowDefinitionStore({findFile: async name => ({nodeId: '/' + name, name}), readFile: async () => source} as FlowStore);
    const execute = vi.fn(async (command: string) => command === FlowCommand.Presentations ? []
        : command === FlowCommand.DraftLoad ? store.loadDraft(template.id) : command === FlowCommand.SourceCheck ? {valid: true, diagnostics: []} : {connections: []});
    const root = document.createElement('div'); document.body.append(root);
    const editor = new FlowsEditor({commands: {execute} as never}, '/' + template.id + '.flow'); editors.push(editor);
    await editor.init(root);
    expect(root.querySelector('[data-flow-node="collect"]')).not.toBeNull();
    expect([...root.querySelectorAll('[role=alert]')].every(alert => !alert.textContent)).toBe(true);
    expect(JSON.parse(source)).not.toHaveProperty('layout');
});

it('reports render failures with safe diagnostics instead of silently leaving an empty editor', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(DagWorkbench.prototype, 'setDraft').mockImplementation(() => {throw new Error('private source text and token');});
    const execute = vi.fn(async (command: string) => command === FlowCommand.Presentations ? [] : calendar);
    const root = document.createElement('div'); document.body.append(root);
    const editor = new FlowsEditor({commands: {execute} as never}, '/collection-a.flow'); editors.push(editor);
    await editor.init(root);
    expect(root.querySelector('[role=alert]')?.textContent).toContain('FLOW_EDITOR_RENDER_FAILED');
    expect(log).toHaveBeenCalledWith('[FlowEditor]', expect.objectContaining({stage: 'draft.render', result: 'failure', code: 'FLOW_EDITOR_RENDER_FAILED', operationId: expect.any(String)}));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private source text');
    expect(root.textContent).not.toContain('private source text');
});
