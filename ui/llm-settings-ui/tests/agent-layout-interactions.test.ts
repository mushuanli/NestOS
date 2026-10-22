// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';

const editors: AgentConfigEditor[] = [];
afterEach(async () => {
    await Promise.all(editors.splice(0).map(editor => editor.destroy()));
    document.body.replaceChildren();
    vi.useRealTimers();
});

async function setup({ readOnly = false, flow = false, type = 'agent' } = {}) {
    const root = document.createElement('div');
    document.body.append(root);
    const saveContent = vi.fn(async (_id: string, _content: string) => {});
    const service = { listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [] };
    const options = { target: { kind: 'entity', entityType: 'agent', id: 'a' }, hostContext: { saveContent }, readOnly };
    const editor = new AgentConfigEditor(root, options as never, service as never, {
        listFlows: async () => flow ? [{ id: 'flow', name: 'Flow', parameters: [{ name: 'data', type: 'json' }] }] : [],
    });
    editors.push(editor);
    await editor.init(root, JSON.stringify({ id: 'a', name: 'Agent', type, config: { systemPrompt: 'Keep these instructions' },
        execution: flow ? { kind: 'flow', flowId: 'flow' } : undefined }));
    return { root, editor, saveContent };
}

function tab(root: HTMLElement, page: string): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>(`[data-agent-page-link="${page}"]`)!;
}

it('uses native section buttons and keeps expanded state in sync without changing the draft', async () => {
    const f = await setup();
    tab(f.root, 'behavior').click();
    const section = f.root.querySelector<HTMLElement>('#llm-config-section')!;
    const button = section.querySelector<HTMLButtonElement>('.agent-section__header')!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(f.editor.isDirty()).toBe(false);
    expect(f.saveContent).not.toHaveBeenCalled();
});

it('keeps compatibility categories independent from behavior and permission edits', async () => {
    const f = await setup({type: 'composite'});
    tab(f.root, 'advanced').click();
    const metadata = f.root.querySelector<HTMLInputElement>('[data-agent-type-metadata]')!;
    expect(metadata.value).toBe('composite'); expect(metadata.readOnly).toBe(true);
    expect(f.root.querySelector('[data-type]')).toBeNull();
    tab(f.root, 'behavior').click();
    const prompt = f.root.querySelector<HTMLTextAreaElement>('[name="systemPrompt"]')!;
    prompt.value = 'Updated instructions'; prompt.dispatchEvent(new Event('input', { bubbles: true }));
    tab(f.root, 'capabilities').click();
    const tools = f.root.querySelector<HTMLTextAreaElement>('[name="toolIds"]')!;
    tools.value = 'Read'; tools.dispatchEvent(new Event('input', { bubbles: true }));
    expect((f.root.querySelector('#llm-config-section') as HTMLElement).style.display).toBe('');
    expect((f.root.querySelector('#mcp-section') as HTMLElement).style.display).toBe('');
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1])).toMatchObject({ type: 'composite', config: { systemPrompt: 'Updated instructions' }, capabilityPolicy: { toolIds: ['Read'] } });
});

it('enables the image size field only for custom sizing and persists that choice', async () => {
    const f = await setup();
    tab(f.root, 'behavior').click();
    const mode = f.root.querySelector<HTMLSelectElement>('[name="imageResizeMode"]')!;
    const edge = f.root.querySelector<HTMLInputElement>('[name="imageMaxEdge"]')!;
    expect(edge.disabled).toBe(true);
    mode.value = 'max-edge';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(edge.disabled).toBe(false);
    edge.value = '2048';
    edge.dispatchEvent(new Event('input', { bubbles: true }));
    await f.editor.flushPendingSave();
    expect(JSON.parse(f.saveContent.mock.calls.at(-1)![1]).config.imageProcessing).toEqual({ resize: { mode: 'max-edge', maxEdge: 2048 } });
    mode.value = 'original';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(edge.disabled).toBe(true);
});

it('changes pages without replacing fields, clearing drafts, or forcing a save', async () => {
    vi.useFakeTimers();
    const f = await setup(); tab(f.root, 'behavior').click();
    const prompt = f.root.querySelector<HTMLTextAreaElement>('[name="systemPrompt"]')!;
    prompt.focus(); prompt.value = 'Unsaved draft'; prompt.dispatchEvent(new Event('input', { bubbles: true }));
    tab(f.root, 'capabilities').focus(); tab(f.root, 'capabilities').click();
    expect(f.saveContent).not.toHaveBeenCalled();
    expect(f.root.querySelector<HTMLElement>('[data-agent-page="behavior"]')!.hidden).toBe(true);
    tab(f.root, 'behavior').click();
    expect(f.root.querySelector('[name="systemPrompt"]')).toBe(prompt);
    expect(prompt.value).toBe('Unsaved draft');
    expect(f.editor.isDirty()).toBe(true);
    await f.editor.flushPendingSave();
});

it('supports roving tab focus with arrows, Home and End', async () => {
    const f = await setup();
    const key = (page: string, value: string) => tab(f.root, page).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
    expect(f.root.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    key('general', 'ArrowRight');
    expect(document.activeElement).toBe(tab(f.root, 'behavior'));
    expect(tab(f.root, 'behavior').getAttribute('aria-selected')).toBe('true');
    key('behavior', 'End'); expect(document.activeElement).toBe(tab(f.root, 'advanced'));
    key('advanced', 'ArrowRight'); expect(document.activeElement).toBe(tab(f.root, 'general'));
    key('general', 'ArrowLeft'); expect(document.activeElement).toBe(tab(f.root, 'advanced'));
    key('advanced', 'Home'); expect(document.activeElement).toBe(tab(f.root, 'general'));
    expect(f.root.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    expect(f.editor.isDirty()).toBe(false);
});

it('reveals and focuses an invalid field from a hidden page without saving the draft', async () => {
    const f = await setup(); tab(f.root, 'behavior').click();
    const field = f.root.querySelector<HTMLInputElement>('[name="temperature"]')!;
    field.value = '3'; field.dispatchEvent(new Event('input', { bubbles: true }));
    f.root.querySelector<HTMLButtonElement>('#llm-config-section .agent-section__header')!.click();
    tab(f.root, 'advanced').click();
    await expect(f.editor.flushPendingSave()).rejects.toThrow();
    expect(tab(f.root, 'behavior').getAttribute('aria-selected')).toBe('true');
    expect(f.root.querySelector('#llm-config-section')!.classList.contains('collapsed')).toBe(false);
    expect(document.activeElement).toBe(field); expect(field.value).toBe('3');
    expect(f.saveContent).not.toHaveBeenCalled();
    field.value = '1'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await f.editor.flushPendingSave();
});

it('returns custom Flow validation errors to the execution page and keeps its JSON draft', async () => {
    const f = await setup({ flow: true });
    const field = f.root.querySelector<HTMLTextAreaElement>('[name="agentFlowParameter:data"]')!;
    field.value = '{'; field.dispatchEvent(new Event('input', { bubbles: true }));
    tab(f.root, 'behavior').click();
    await expect(f.editor.flushPendingSave()).rejects.toThrow();
    expect(tab(f.root, 'general').getAttribute('aria-selected')).toBe('true');
    expect(field.value).toBe('{'); expect(f.saveContent).not.toHaveBeenCalled();
    field.value = '{}'; field.dispatchEvent(new Event('input', { bubbles: true }));
    await f.editor.flushPendingSave();
});

it('keeps page and section navigation available in read-only editors', async () => {
    const f = await setup({ readOnly: true });
    expect(f.root.querySelector<HTMLInputElement>('[name="name"]')!.disabled).toBe(true);
    expect(f.root.querySelector<HTMLInputElement>('[data-agent-type-metadata]')!.readOnly).toBe(true);
    tab(f.root, 'behavior').click();
    expect(tab(f.root, 'behavior').disabled).toBe(false);
    expect(f.root.querySelector<HTMLElement>('[data-agent-page="behavior"]')!.hidden).toBe(false);
    const section = f.root.querySelector<HTMLElement>('#llm-config-section')!;
    const toggle = section.querySelector<HTMLButtonElement>('.agent-section__header')!;
    expect(toggle.disabled).toBe(false); toggle.click();
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(f.saveContent).not.toHaveBeenCalled();
});
