// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';

const editors: AgentConfigEditor[] = [];
afterEach(async () => { await Promise.all(editors.splice(0).map(editor => editor.destroy())); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function setup() {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = document.createElement('div'); document.body.append(root);
    const saveContent = vi.fn(async () => {});
    const service = { listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [] };
    const definition = { id: 'registered', name: 'Registered flow',
        parameters: [{ name: 'level', type: 'number' as const, minimum: 0 }, { name: 'groups', type: 'json' as const },
            { name: 'systemPrompt', type: 'string' as const }, { name: 'temperature', type: 'number' as const }],
        connections: [{ name: 'vision', description: 'Image model' }] };
    const editor = new AgentConfigEditor(root, { target: { kind: 'entity', entityType: 'agent', id: 'a' }, hostContext: { saveContent } } as never,
        service as never, { listFlows: async () => [definition], listFlowRevisions: async () => [{ ...definition, revision: 3 }],
            getFlowRevision: async () => ({ ...definition, revision: 3 }), listConnections: async () => [{ id: 'camera', name: 'Camera model' }] });
    editors.push(editor);
    await editor.init(root, JSON.stringify({ id: 'a', name: 'Reader', type: 'agent', config: { systemPrompt: 'preserved' }, capabilityPolicy: { toolIds: ['Read'] } }));
    const change = (name: string, value: string) => {
        const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const loaded = () => vi.waitFor(() => expect(root.querySelector('[data-agent-execution]')?.getAttribute('data-state')).toBe('ready'));
    return { root, editor, change, saveContent, loaded };
}

it('saves schema defaults and selected published versions while preserving Agent policy', async () => {
    const f = await setup();
    f.change('executionKind', 'flow'); await f.loaded();
    expect(f.root.querySelector<HTMLElement>('[data-agent-flow-fields]')!.hidden).toBe(false);
    expect(f.root.querySelector<HTMLSelectElement>('[name="executionFlowId"]')!.value).toBe('registered');
    expect([...f.root.querySelectorAll('[name="executionRevision"] option')].map(option => option.textContent)).toEqual(['latest · 跟随最新发布', 'v3']);
    f.change('executionRevision', '3'); await f.loaded();
    f.change('agentFlowParameter:level', '2'); f.change('agentFlowConnection:vision', JSON.stringify('camera'));
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1])).toMatchObject({
        execution: { kind: 'flow', flowId: 'registered', revision: 3, parameters: { level: 2 }, connectionBindings: { vision: 'camera' } },
        config: { systemPrompt: 'preserved' }, capabilityPolicy: { toolIds: ['Read'] },
    });
    f.change('executionRevision', ''); await f.loaded(); await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1]).execution).not.toHaveProperty('revision');
});

it('retains invalid field drafts and accepts correction without losing the binding form', async () => {
    const f = await setup(); f.change('executionKind', 'flow'); await f.loaded(); await f.editor.flushPendingSave();
    const field = f.root.querySelector('[name="agentFlowParameter:groups"]'); f.saveContent.mockClear();
    f.change('agentFlowParameter:groups', '{'); await expect(f.editor.flushPendingSave()).rejects.toThrow();
    expect(f.saveContent).not.toHaveBeenCalled(); expect(f.root.querySelector('[name="agentFlowParameter:groups"]')).toBe(field);
    f.change('agentFlowParameter:groups', '[[1],[2]]'); await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1]).execution.parameters).toEqual({ groups: [[1], [2]] });
});

it('keeps Flow fields separate from identically named Agent settings', async () => {
    const f = await setup(); f.change('executionKind', 'flow'); await f.loaded();
    f.change('agentFlowParameter:systemPrompt', 'Flow-only instructions'); f.change('agentFlowParameter:temperature', '1.5');
    await f.editor.flushPendingSave();
    const saved = JSON.parse(f.saveContent.mock.calls.at(-1)![1]);
    expect(saved.execution.parameters).toMatchObject({ systemPrompt: 'Flow-only instructions', temperature: 1.5 });
    expect(saved.config.systemPrompt).toBe('preserved'); expect(saved.config.temperature).toBeUndefined();
});
