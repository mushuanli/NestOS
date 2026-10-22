import { escapeHTML, t } from '@itookit/common';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';

export interface AgentFlowChoice { id: string; name: string; }

export function renderAgentExecution(agent: AgentDefinition, flows: AgentFlowChoice[]): string {
    const execution = agent.execution?.kind === 'flow' ? agent.execution : undefined;
    const choices = [...flows];
    if (execution && !choices.some(flow => flow.id === execution.flowId)) choices.push({ id: execution.flowId, name: execution.flowId });
    const json = (value: unknown) => escapeHTML(JSON.stringify(value ?? {}, null, 2));
    return `<div class="agent-section" data-agent-execution><div class="agent-section__body">
        <label>${t('agent.execution.title')}<select name="executionKind"><option value="agent">${t('agent.execution.agent')}</option><option value="flow" ${execution ? 'selected' : ''}>${t('agent.execution.flow')}</option></select></label>
        <div data-agent-flow-fields ${execution ? '' : 'hidden'}>
            <label>${t('agent.execution.definition')}<select name="executionFlowId"><option value=""></option>${choices.map(flow => `<option value="${escapeHTML(flow.id)}" ${execution?.flowId === flow.id ? 'selected' : ''}>${escapeHTML(flow.name)}</option>`).join('')}</select></label>
            <label>${t('agent.execution.revision')}<input name="executionRevision" type="number" min="1" step="1" value="${escapeHTML(String(execution?.revision ?? ''))}"></label>
            <label>${t('agent.execution.parameters')}<textarea name="executionParameters" rows="5">${json(execution?.parameters)}</textarea></label>
            <label>${t('agent.execution.bindings')}<textarea name="executionBindings" rows="3">${json(execution?.connectionBindings)}</textarea></label>
            <p class="agent-form-help">${t('agent.execution.promptHint')}</p>
        </div></div></div>`;
}

export function readAgentExecution(root: HTMLElement): AgentDefinition['execution'] {
    const field = (name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${name}"]`)!.value;
    if (field('executionKind') !== 'flow') return { kind: 'agent' };
    const flowId = field('executionFlowId'), rawRevision = field('executionRevision');
    if (!flowId) throw new Error(t('agent.execution.required'));
    const revision = rawRevision ? Number(rawRevision) : undefined;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error(t('agent.execution.invalidRevision'));
    const parameters = object(field('executionParameters'));
    const connectionBindings = object(field('executionBindings'));
    if (Object.values(connectionBindings).some(value => typeof value !== 'string')) throw new Error(t('agent.execution.invalidBindings'));
    return { kind: 'flow', flowId, revision, parameters, connectionBindings: connectionBindings as Record<string, string> };
}

function object(source: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(source || '{}'); } catch { throw new Error(t('agent.execution.invalidObject')); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('agent.execution.invalidObject'));
    return value as Record<string, unknown>;
}

export function bindAgentExecution(root: HTMLElement): void {
    const kind = root.querySelector<HTMLSelectElement>('[name="executionKind"]');
    kind?.addEventListener('change', () => { root.querySelector<HTMLElement>('[data-agent-flow-fields]')!.hidden = kind.value !== 'flow'; });
}
