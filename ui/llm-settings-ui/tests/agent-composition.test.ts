// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { AgentConfigEditor } from '../src/editors/AgentConfigEditor';
import { renderAgentComposition, readAgentComposition, bindAgentComposition } from '../src/editors/agent-composition';

const definition = (id: string, extra = {}): AgentDefinition => ({ id, name: id, type: 'agent', config: {}, ...extra });
const candidates = [definition('self'), definition('host'), definition('member'), definition('flow', {execution: {kind: 'flow', flowId: 'flow'}})];
const editors: AgentConfigEditor[] = [];
afterEach(async () => { for (const editor of editors.splice(0)) await editor.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('offers only direct Agents, keeps the coordinator outside the selectable members, and reads bounded collaboration settings', () => {
    const root = document.createElement('div');
    root.innerHTML = '<select name="executionKind"><option selected>composite</option></select>' + renderAgentComposition(definition('self', {
        composition: {coordinatorAgentId: 'host', memberAgentIds: ['member'], maxDelegations: 3},
    }), candidates);
    bindAgentComposition(root);
    expect(root.querySelector('[name=compositionCoordinator] option[value=self]')).toBeNull();
    expect(root.querySelector('[name=compositionCoordinator] option[value=flow]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[name=compositionMember][value=host]')!.disabled).toBe(true);
    expect(readAgentComposition(root)).toEqual({coordinatorAgentId: 'host', memberAgentIds: ['member'], maxDelegations: 3});
    root.querySelector<HTMLInputElement>('[name=compositionMember][value=member]')!.checked = false;
    expect(() => readAgentComposition(root)).toThrow('至少');
});

it('keeps unavailable saved Agent references visible and rejects non-positive task limits', () => {
    const root = document.createElement('div');
    root.innerHTML = '<select name="executionKind"><option selected>composite</option></select>' + renderAgentComposition(definition('self', {
        composition: {coordinatorAgentId: 'removed', memberAgentIds: ['member'], maxConcurrency: 0},
    }), candidates);
    expect(root.querySelector<HTMLSelectElement>('[name=compositionCoordinator]')!.value).toBe('removed');
    expect(root.textContent).toContain('Agent 不可用');
    expect(() => readAgentComposition(root)).toThrow('正整数');
});

it('uses the authoritative Agent service for composite preparation and reflects its canonical Flow binding', async () => {
    let saved = definition('self');
    const saveContent = vi.fn(async () => {});
    const service = { listSystemPrompts: async () => [], getMCPServers: async () => [], getSkills: async () => [], getAgents: async () => candidates,
        saveAgent: vi.fn(async (agent: AgentDefinition) => { saved = {...agent, execution: {kind: 'flow', flowId: 'managed-self', revision: 2}}; }),
        getAgentConfig: async () => saved };
    const root = document.createElement('div'); document.body.append(root);
    const editor = new AgentConfigEditor(root, {target: {kind: 'entity', entityType: 'agent', id: 'self'}, hostContext: {saveContent}} as never, service as never);
    editors.push(editor); await editor.init(root, JSON.stringify(saved));
    const change = (name: string, value: string) => { const field = root.querySelector<HTMLSelectElement>(`[name="${name}"]`)!; field.value = value; field.dispatchEvent(new Event('change', {bubbles: true})); };
    change('executionKind', 'composite'); change('compositionCoordinator', 'host');
    const member = root.querySelector<HTMLInputElement>('[name=compositionMember][value=member]')!; member.checked = true; member.dispatchEvent(new Event('change', {bubbles: true}));
    await editor.flushPendingSave();
    expect(service.saveAgent).toHaveBeenCalled(); expect(saveContent).not.toHaveBeenCalled();
    expect(saved.composition).toEqual({coordinatorAgentId: 'host', memberAgentIds: ['member']});
    expect(JSON.parse(editor.getText()).execution).toEqual({kind: 'flow', flowId: 'managed-self', revision: 2});
    expect(root.querySelector('[data-agent-composition-status]')?.textContent).toContain('v2');
    change('executionKind', 'agent'); await editor.flushPendingSave();
    expect(service.saveAgent.mock.calls.at(-1)![0].composition).toBeUndefined();
});

it('allows remote members while rejecting a remote coordinator in the form', () => {
    const root = document.createElement('div');
    const remote = definition('remote', { execution: { kind: 'harness', connectionId: 'execution' } });
    root.innerHTML = '<select name="executionKind"><option selected>composite</option></select>' + renderAgentComposition(definition('self', {
        composition: { coordinatorAgentId: 'host', memberAgentIds: ['remote'] },
    }), [...candidates, remote]);
    const select = root.querySelector<HTMLSelectElement>('[name=compositionCoordinator]')!;
    expect(select.querySelector<HTMLOptionElement>('[value=remote]')!.disabled).toBe(true);
    expect(readAgentComposition(root)).toEqual({ coordinatorAgentId: 'host', memberAgentIds: ['remote'] });
    select.value = 'remote'; expect(() => readAgentComposition(root)).toThrow();
});
