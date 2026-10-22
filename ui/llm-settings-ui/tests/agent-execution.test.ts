// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';

const editors: AgentConfigEditor[] = [];
afterEach(async () => { await Promise.all(editors.splice(0).map(editor => editor.destroy())); document.body.replaceChildren(); vi.useRealTimers(); });

async function setup() {
    const root = document.createElement('div'); document.body.append(root);
    const saveContent = vi.fn(async () => {});
    const service = { listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [] };
    const editor = new AgentConfigEditor(root, { target: { kind: 'entity', entityType: 'agent', id: 'a' }, hostContext: { saveContent } } as never,
        service as never, { listFlows: async () => [{ id: 'registered', name: 'Registered flow' }] });
    editors.push(editor);
    await editor.init(root, JSON.stringify({ id: 'a', name: 'Reader', type: 'agent', config: { systemPrompt: 'preserved' }, capabilityPolicy: { toolIds: ['Read'] } }));
    const change = (name: string, value: string) => {
        const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    return { root, editor, change, saveContent };
}

it('saves a registered Flow binding with an optional revision and defaults while preserving Agent policy', async () => {
    const f = await setup();
    f.change('executionKind', 'flow'); expect(f.root.querySelector<HTMLElement>('[data-agent-flow-fields]')!.hidden).toBe(false);
    f.change('executionFlowId', 'registered'); f.change('executionRevision', '3');
    f.change('executionParameters', '{"level":2}'); f.change('executionBindings', '{"vision":"camera"}');
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1])).toMatchObject({
        execution: { kind: 'flow', flowId: 'registered', revision: 3, parameters: { level: 2 }, connectionBindings: { vision: 'camera' } },
        config: { systemPrompt: 'preserved' }, capabilityPolicy: { toolIds: ['Read'] },
    });
    f.change('executionRevision', ''); await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1]).execution).not.toHaveProperty('revision');
});

it('blocks malformed defaults and accepts correction without losing the binding form', async () => {
    const f = await setup(); f.change('executionKind', 'flow'); f.change('executionFlowId', 'registered');
    const field = f.root.querySelector('[name="executionParameters"]');
    f.change('executionParameters', '[]'); await expect(f.editor.flushPendingSave()).rejects.toThrow();
    expect(f.saveContent).not.toHaveBeenCalled(); expect(f.root.querySelector('[name="executionParameters"]')).toBe(field);
    f.change('executionParameters', '{"groups":[[1],[2]]}'); await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1]).execution.parameters).toEqual({ groups: [[1], [2]] });
});
