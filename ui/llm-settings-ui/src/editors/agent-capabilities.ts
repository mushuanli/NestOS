import { escapeHTML, t } from '@itookit/common';
import type { AgentDefinition, LLMSkill } from '@itookit/kernel-adapters/contracts';

/** Defaults describe host policy; undefined grants continue to inherit that policy. */
export interface AgentCapabilityOptions { defaultToolIds?: readonly string[]; }

const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];

/** Undefined and an explicit empty list have different authority semantics. */
export function renderAgentCapabilities(agent: AgentDefinition, skills: LLMSkill[], defaultToolIds: readonly string[] = []): string {
    const policy = agent.capabilityPolicy;
    const selected = new Set(policy?.skillIds ?? []);
    const tools = [...new Set([...defaultToolIds, ...skills.flatMap(skill => skill.tools.map(tool => tool.toolId))])];
    const grants = new Set(policy?.toolIds ?? defaultToolIds);
    const additional = (policy?.toolIds ?? []).filter(id => !tools.includes(id));
    const available = new Map(skills.map(skill => [skill.id, skill]));
    for (const id of selected) if (!available.has(id)) available.set(id, { id, name: id, tools: [] } as unknown as LLMSkill);
    return `<div class="agent-section" data-capability-editor>
        <div class="agent-section__header">${t('agent.capabilities.title')}</div>
        <div class="agent-section__body">
            <label><input type="checkbox" name="defaultTools" ${policy?.toolIds === undefined ? 'checked' : ''}> ${t('agent.capabilities.defaults')}</label>
            <p class="agent-form-help">${t('agent.capabilities.help')}</p>
            <div>${tools.map(id => `<label class="agent-mcp-item"><input type="checkbox" name="toolGrant" value="${escapeHTML(id)}" ${grants.has(id) ? 'checked' : ''}>${escapeHTML(id)}</label>`).join('')}</div>
            <label>${t('agent.capabilities.tools')}<textarea class="agent-form-input" name="toolIds" rows="3">${escapeHTML(additional.join('\n'))}</textarea></label>
            <p class="agent-form-help">${t('agent.capabilities.skillHelp')}</p>
            ${[...available.values()].map(skill => `<label class="agent-mcp-item">
                <input type="checkbox" name="skillIds" value="${escapeHTML(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}>
                <span>${escapeHTML(skill.name)}<small> ${escapeHTML(skill.tools.map(tool => tool.toolId).join(', '))}</small></span>
            </label>`).join('')}
        </div></div>`;
}

export function readAgentCapabilities(container: HTMLElement, previous: AgentDefinition['capabilityPolicy']): AgentDefinition['capabilityPolicy'] {
    if (!container.querySelector('[data-capability-editor]')) return previous;
    const defaults = container.querySelector<HTMLInputElement>('[name="defaultTools"]')!.checked;
    const tools = container.querySelector<HTMLTextAreaElement>('[name="toolIds"]')!.value;
    const checked = (name: string) => [...container.querySelectorAll<HTMLInputElement>(`[name="${name}"]:checked`)].map(input => input.value);
    return { ...previous, toolIds: defaults ? undefined : [...new Set([...checked('toolGrant'), ...ids(tools)])], skillIds: checked('skillIds'), mcpProfileIds: checked('mcpServers') };
}

export function bindAgentCapabilities(container: HTMLElement, defaultToolIds: readonly string[] = []): void {
    const update = (event: Event) => {
        const input = event.target as HTMLInputElement;
        const defaults = container.querySelector<HTMLInputElement>('[name="defaultTools"]')!;
        if (input.name === 'toolGrant' || input.name === 'toolIds') defaults.checked = false;
        if (input.name === 'defaultTools' && defaults.checked) {
            container.querySelectorAll<HTMLInputElement>('[name="toolGrant"]').forEach(tool => { tool.checked = defaultToolIds.includes(tool.value); });
            container.querySelector<HTMLTextAreaElement>('[name="toolIds"]')!.value = '';
        }
    };
    const section = container.querySelector('[data-capability-editor]');
    section?.addEventListener('input', update); section?.addEventListener('change', update);
}
