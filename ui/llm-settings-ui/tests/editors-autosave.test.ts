// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';
import { SkillSettingsEditor } from '../src/editors/SkillSettingsEditor';
import { MCPSettingsEditor } from '../src/editors/MCPSettingsEditor';
import { SystemPromptSettingsEditor } from '../src/editors/SystemPromptSettingsEditor';
import { CostEditor } from '../src/editors/CostEditor';

const editors: Array<{ destroy(): Promise<void> }> = [];
afterEach(async () => {
    await Promise.all(editors.splice(0).map(editor => editor.destroy()));
    vi.useRealTimers(); document.body.innerHTML = '';
});
function mount(): HTMLDivElement { const container = document.createElement('div'); document.body.append(container); return container; }
function change(container: HTMLElement, selector: string, value: string): HTMLInputElement {
    const field = container.querySelector<HTMLInputElement>(selector)!;
    field.focus(); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); return field;
}

it('saves Agent instructions through the host without a second writer or replacing the DOM', async () => {
    vi.useFakeTimers(); const container = mount(); const saveContent = vi.fn().mockResolvedValue(undefined);
    const saveAgent = vi.fn();
    const service = { listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [], saveAgent };
    const editor = new AgentConfigEditor(container, { target: { kind: 'entity', entityType: 'agent', id: 'a' }, hostContext: { saveContent } } as never, service as never);
    editors.push(editor);
    await editor.init(container, JSON.stringify({ id: 'a', name: 'Agent', type: 'agent', config: { systemPrompt: 'old' }, capabilityPolicy: { toolIds: ['Read'] } }));
    const interactive = vi.fn(); editor.on('interactiveChange', interactive);
    const field = change(container, '[name="systemPrompt"]', 'new instructions');
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveContent).toHaveBeenCalledOnce(); expect(saveAgent).not.toHaveBeenCalled(); expect(interactive).not.toHaveBeenCalled();
    expect(JSON.parse(saveContent.mock.calls[0][1])).toMatchObject({ config: { systemPrompt: 'new instructions' }, capabilityPolicy: { toolIds: ['Read'] } });
    expect(document.activeElement).toBe(field); expect(field.isConnected).toBe(true);
});

it('saves Skill changes and preserves hidden fields when the service announces its own write', async () => {
    vi.useFakeTimers(); const container = mount(); let notify = () => {};
    const skill = { id: 's', name: 'Skill', type: 'prompt', enabled: true, instructions: 'old', tools: [], triggerPatterns: [],
        taskProgram: { kind: 'hidden', version: '1' } };
    const saveSkill = vi.fn().mockImplementation(async () => { notify(); });
    const service = { getSkills: async () => [skill], getMCPServers: async () => [], saveSkill,
        onChange: (callback: () => void) => { notify = callback; return () => {}; } };
    const editor = SkillSettingsEditor.createFormOnly(container, service as never, { target: { kind: 'entity', entityType: 'skill', id: 's' } });
    editors.push(editor); await editor.init(container);
    const field = change(container, '[name="instructions"]', 'updated'); await vi.advanceTimersByTimeAsync(1000);
    expect(saveSkill).toHaveBeenCalledOnce(); expect(saveSkill.mock.calls[0][0]).toMatchObject({ instructions: 'updated', taskProgram: skill.taskProgram });
    expect(container.querySelector('[name="instructions"]')).toBe(field); expect(container.querySelector('[data-action="save"]')).toBeNull();
});

it('validates MCP JSON and persists corrected transport settings in place', async () => {
    vi.useFakeTimers(); const container = mount(); const saveMCPServer = vi.fn().mockResolvedValue(undefined);
    const server = { id: 'm', name: 'MCP', transport: 'http', endpoint: 'https://example.com/mcp', timeout: 15000, timeoutUnit: 'ms', tools: [], resources: [] };
    const service = { getMCPServers: async () => [server], saveMCPServer };
    const editor = new MCPSettingsEditor(container, service as never, { target: { kind: 'entity', entityType: 'mcp', id: 'm' } });
    editors.push(editor); await editor.init(container);
    const field = change(container, '[name="headers"]', '{invalid'); await vi.advanceTimersByTimeAsync(1000);
    expect(saveMCPServer).not.toHaveBeenCalled();
    change(container, '[name="headers"]', '{"X-Test":"yes"}'); await vi.advanceTimersByTimeAsync(1000);
    expect(saveMCPServer).toHaveBeenCalledOnce(); expect(saveMCPServer.mock.calls[0][0]).toMatchObject({ headers: { 'X-Test': 'yes' }, timeout: 15000 });
    expect(container.querySelector('[name="headers"]')).toBe(field);
});

it.each([undefined, true, false])('shows the backend startup policy for MCP autoConnect=%s', async autoConnect => {
    vi.useFakeTimers(); const container = mount(), saveMCPServer = vi.fn().mockResolvedValue(undefined);
    const server = { id: 'm', name: 'MCP', transport: 'http', endpoint: 'https://example.invalid/mcp', autoConnect };
    const editor = new MCPSettingsEditor(container, { getMCPServers: async () => [server], saveMCPServer } as never,
        { target: { kind: 'entity', entityType: 'mcp', id: 'm' } });
    editors.push(editor); await editor.init(container);
    const checkbox = container.querySelector<HTMLInputElement>('[name="autoConnect"]')!;
    expect(checkbox.getAttribute('role')).toBe('switch');
    expect(checkbox.closest('.settings-section')).toBeNull();
    expect(checkbox.checked).toBe(autoConnect !== false);
    checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveMCPServer).toHaveBeenCalledWith(expect.objectContaining({ autoConnect: false }));
});

it('saves System Prompt content without flattening unchanged message groups or re-rendering', async () => {
    vi.useFakeTimers(); const container = mount(); const saveSystemPrompt = vi.fn().mockResolvedValue(undefined);
    const prompt = { id: 'p', name: 'Prompt', content: ['first', 'second'], description: 'old' };
    const service = { listSystemPrompts: async () => [prompt], saveSystemPrompt };
    const editor = new SystemPromptSettingsEditor(container, service as never, { target: { kind: 'entity', entityType: 'system-prompt', id: 'p' } });
    editors.push(editor); await editor.init(container);
    const field = change(container, '[data-field="description"]', 'new'); await vi.advanceTimersByTimeAsync(600);
    expect(saveSystemPrompt).toHaveBeenCalledOnce(); expect(saveSystemPrompt.mock.calls[0][0]).toMatchObject({ content: ['first', 'second'], description: 'new' });
    expect(container.querySelector('[data-field="description"]')).toBe(field);
});

it('auto-saves pricing edits without requiring a save button', async () => {
    vi.useFakeTimers(); const container = mount(); const writePricing = vi.fn().mockResolvedValue(undefined);
    const service = { getProviders: () => [], queryCosts: async () => [], writePricing,
        getPricingConfig: () => ({ model_pricing: [{ id: 'default', price: [1, 2, 0, 0], providers: {}, names: [] }] }) };
    const editor = new CostEditor(container, service as never, {}); editors.push(editor); await editor.init(container);
    const pricing = container.querySelector<HTMLDetailsElement>('#cost-panel-pricing')!; pricing.open = true; pricing.dispatchEvent(new Event('toggle')); await vi.advanceTimersByTimeAsync(0);
    const field = change(container, '.cost-pricing-input[data-field="0"]', '3.5'); await vi.advanceTimersByTimeAsync(600);
    expect(writePricing).toHaveBeenCalledOnce(); expect(writePricing.mock.calls[0][0].model_pricing[0].price[0]).toBe(3.5);
    expect(container.querySelector('#btn-save-pricing')).toBeNull(); expect(field.isConnected).toBe(true);
});

it.each([true, false, undefined])('uses the service capability (%s) for MCP stdio controls', async supported => {
    const container = mount();
    const server = { id: 'm', name: 'MCP', transport: 'http', endpoint: 'https://example.com/mcp', tools: [], resources: [] };
    const service = { getMCPServers: async () => [server],
        ...(supported === undefined ? {} : { supportsMCPStdio: () => supported }) };
    const editor = new MCPSettingsEditor(container, service as never, { target: { kind: 'entity', entityType: 'mcp', id: 'm' } });
    editors.push(editor); await editor.init(container);
    expect(container.querySelector<HTMLOptionElement>('option[value="stdio"]')!.disabled).toBe(supported !== true);
});

it('saves explicit anonymous MCP access without retaining API keys or Authorization headers',async()=>{
    vi.useFakeTimers();const container=mount(),saveMCPServer=vi.fn().mockResolvedValue(undefined);
    const server={id:'public',name:'Public',transport:'http',endpoint:'https://example.test/mcp',apiKey:'fixture-private-key',headers:{Authorization:'Bearer fixture-header'}};
    const editor=new MCPSettingsEditor(container,{getMCPServers:async()=>[server],saveMCPServer} as never,{target:{kind:'entity',entityType:'mcp',id:'public'}});
    editors.push(editor);await editor.init(container);
    change(container,'[name="authenticationMode"]','anonymous');await vi.advanceTimersByTimeAsync(1000);
    expect(saveMCPServer).toHaveBeenCalledOnce();
    const saved=saveMCPServer.mock.calls[0][0];
    expect(saved.auth).toMatchObject({type:'anonymous',credentialRef:'mcp-public'});
    expect(saved.apiKey).toBeUndefined();expect(saved.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('fixture-private');
});

it('flushes host-owned settings on navigation and retains failed settings for retry', async () => {
    const container = mount(), flush = vi.fn().mockRejectedValueOnce(new Error('Project save failed')).mockResolvedValue(undefined), destroy = vi.fn(async () => {});
    const saveAgent = vi.fn(), mountSettings = vi.fn(async (slot: HTMLElement) => {
        slot.textContent = 'Project settings'; return {flush, destroy, isDirty: () => true};
    });
    const editor = new AgentConfigEditor(container, {target: {kind: 'entity', entityType: 'agent', id: 'a'}, mountSettings},
        {listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [], saveAgent} as never);
    editors.push(editor); await editor.init(container, JSON.stringify({id: 'a', name: 'Agent', config: {}}));
    expect(mountSettings).toHaveBeenCalledOnce(); expect(editor.isDirty()).toBe(true);
    await expect(editor.flushPendingSave()).rejects.toThrow('Project save failed'); expect(destroy).not.toHaveBeenCalled();
    await editor.flushPendingSave(); expect(saveAgent).not.toHaveBeenCalled();
});
