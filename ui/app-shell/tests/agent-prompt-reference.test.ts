// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../../llm-settings-ui/src/editors/AgentConfigEditor';
import { buildExecutorOptions } from '../../llm-ui/src/shell/AgentProvider';
import type { SystemPromptDefinition } from '@itookit/llm-tasks/contracts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
async function fixture(selected?: string) {
    const prompts: SystemPromptDefinition[] = [{ id: 'shared', name: '<Shared>', content: ['Shared rule'], presets: [{ name: 'Review', prompt: 'Review it' }] }];
    const service = { listSystemPrompts: async () => [...prompts], getSystemPrompt: async (id: string) => prompts.find(prompt => prompt.id === id) ?? null,
        saveSystemPrompt: vi.fn(async (prompt: SystemPromptDefinition) => { prompts.push(prompt); }),
        saveAgent: vi.fn(async () => {}), getMCPServers: async () => [], getSkills: async () => [] };
    const host = document.createElement('div'), navigate = vi.fn();
    const editor = new AgentConfigEditor(host, { hostContext: { navigate } } as never, service as never);
    cleanup.push(() => editor.destroy());
    await editor.init(host, JSON.stringify({ id: 'writer', name: 'Writer', type: 'agent',
        config: { systemPromptId: selected, systemPrompt: 'My instructions' }, defaultPrompts: [{ name: 'Own', prompt: 'Mine' }] }));
    await vi.waitFor(() => expect(host.querySelector('[data-prompt-preview]')).not.toBeNull());
    const select = host.querySelector<HTMLSelectElement>('[name="systemPromptId"]')!;
    return { prompts, service, host, editor, select, navigate };
}

it('stores a reference without copying shared instructions or presets into the Agent', async () => {
    const f = await fixture(); f.select.value = 'shared'; f.select.dispatchEvent(new Event('change'));
    const agent = JSON.parse(f.editor.getText());
    expect(agent.config).toMatchObject({ systemPromptId: 'shared', systemPrompt: 'My instructions' });
    expect(agent.defaultPrompts).toEqual([{ name: 'Own', prompt: 'Mine' }]);
    expect(f.host.querySelector<HTMLTextAreaElement>('[data-prompt-preview]')?.value).toBe('Shared rule');
    f.host.querySelector<HTMLButtonElement>('[data-prompt-edit]')!.click();
    expect(f.navigate).toHaveBeenCalledWith({ target: 'toolbox', resourceId: '/prompts/shared' });
    const options = await buildExecutorOptions({ ...f.service, listAgents: () => [agent] } as never);
    expect(options.find(option => option.id === 'writer')?.defaultPrompts).toEqual([{ name: 'Review', prompt: 'Review it' }, { name: 'Own', prompt: 'Mine' }]);
    f.select.value = ''; f.select.dispatchEvent(new Event('change'));
    expect(JSON.parse(f.editor.getText()).config.systemPromptId).toBeUndefined();
});

it('copies the shared definition explicitly and selects the independent copy', async () => {
    const f = await fixture('shared');
    f.host.querySelector<HTMLButtonElement>('[data-prompt-copy]')!.click();
    await vi.waitFor(() => expect(f.service.saveSystemPrompt).toHaveBeenCalledOnce());
    const copied = f.service.saveSystemPrompt.mock.calls[0][0];
    expect(copied.id).not.toBe('shared'); expect(copied.content).toEqual(['Shared rule']);
    expect(JSON.parse(f.editor.getText()).config.systemPromptId).toBe(copied.id);
    await f.editor.flushPendingSave();
    expect(f.service.saveAgent).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ systemPromptId: copied.id }) }));
    copied.content[0] = 'Changed copy'; expect(f.prompts[0].content).toEqual(['Shared rule']);
});

it('keeps a missing reference visible and selected until the user replaces it', async () => {
    const f = await fixture('missing');
    expect(f.select.value).toBe('missing');
    expect(JSON.parse(f.editor.getText()).config.systemPromptId).toBe('missing');
    expect(f.host.querySelector<HTMLButtonElement>('[data-prompt-copy]')?.disabled).toBe(true);
});
