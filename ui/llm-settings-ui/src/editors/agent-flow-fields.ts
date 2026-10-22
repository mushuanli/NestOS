import { escapeHTML, t } from '@itookit/common';
import { SettingsValidationError } from '@itookit/ui-common';
import { renderParameterFields, readParameterFields, type FormParameter, type ParameterFormOptions } from '@itookit/llm-ui/forms';
import type { AgentFlowConnection, AgentFlowDefinition } from './agent-execution-options';

export interface AgentFlowFieldDefaults {
    parameters?: Record<string, unknown>;
    connectionBindings?: Record<string, string>;
}

const encoded = (value: unknown) => escapeHTML(JSON.stringify(value));

export function renderAgentFlowFields(
    definition: AgentFlowDefinition,
    defaults: AgentFlowFieldDefaults,
    connections: Array<{ id: string; name: string }>,
): string {
    const parameters = definition.parameters ?? [], slots = connectionParameters(definition.connections ?? [], connections);
    const parameterFields = renderParameterFields(parameters, fieldOptions(defaults.parameters, 'agentFlowParameter:'));
    const bindingFields = renderParameterFields(slots, {
        ...fieldOptions(defaults.connectionBindings, 'agentFlowConnection:'),
        optionLabel: value => connections.find(connection => connection.id === value)?.name ?? t('connection.unavailable', { id: String(value) }),
    });
    return `<div data-agent-flow-fields-editor data-flow-field-defaults="${encoded(defaults)}" data-flow-field-definition="${encoded({ parameters, slots })}">
        ${renderGroup('parameters', parameterFields)}${renderGroup('connections', bindingFields)}
    </div>`;
}

function renderGroup(kind: 'parameters' | 'connections', fields: string): string {
    const marker = kind === 'parameters' ? 'data-agent-flow-parameters' : 'data-agent-flow-bindings';
    return `<fieldset class="agent-flow-fields__group"><legend>${t(`agent.execution.fields.${kind}`)}</legend>
        <p class="agent-form-help">${t(`agent.execution.fields.${kind}Help`)}</p>
        <div class="agent-form-grid" ${marker}>${fields || `<p class="agent-form-help">${t(`agent.execution.fields.${kind}Empty`)}</p>`}</div>
    </fieldset>`;
}

function fieldOptions(values?: Record<string, unknown>, namePrefix?: string): ParameterFormOptions {
    return {
        mode: 'defaults', values, namePrefix,
        classes: { field: 'agent-form-row', label: 'agent-form-label', help: 'agent-form-help',
            input: 'agent-form-input', select: 'agent-form-select', textarea: 'agent-form-textarea', wide: 'agent-form-row--wide' },
        labels: { inherit: t('agent.execution.fields.inherit'), on: t('agent.execution.fields.on'), off: t('agent.execution.fields.off'),
            required: t('agent.execution.fields.requiredAtRun'), unavailableOption: t('agent.execution.fields.unavailableOption'),
            defaultValue: value => t('agent.execution.fields.flowDefault', { value }) },
        error: fieldError,
    };
}

function fieldError(kind: Parameters<NonNullable<ParameterFormOptions['error']>>[0], parameter: FormParameter): string {
    const name = parameter.label?.trim() || parameter.name;
    if (kind === 'json') return t('agent.execution.fields.invalidJson', { name });
    if (kind === 'number') return t('agent.execution.fields.invalidNumber', { name });
    if (kind !== 'range') return t('agent.execution.fields.invalidValue', { name });
    const constraints = [parameter.integer ? t('agent.execution.fields.integer') : undefined,
        parameter.minimum !== undefined ? t('agent.execution.fields.minimum', { value: parameter.minimum }) : undefined,
        parameter.maximum !== undefined ? t('agent.execution.fields.maximum', { value: parameter.maximum }) : undefined,
    ].filter(Boolean).join(' · ');
    return t('agent.execution.fields.invalidRange', { name, constraints });
}

function connectionParameters(slots: AgentFlowConnection[], connections: Array<{ id: string; name: string }>): FormParameter[] {
    return slots.map(slot => ({
        name: slot.name, type: 'string', widget: 'select', required: slot.required !== false,
        description: [slot.description, slot.connectionId ? t('agent.execution.fields.inheritConnection', {
            name: connections.find(connection => connection.id === slot.connectionId)?.name ?? slot.connectionId,
        }) : undefined].filter(Boolean).join(' · '),
        options: connections.map(connection => connection.id),
    }));
}

export function readAgentFlowFields(root: HTMLElement): Required<AgentFlowFieldDefaults> {
    const editor = root.matches('[data-agent-flow-fields-editor]') ? root : root.querySelector<HTMLElement>('[data-agent-flow-fields-editor]');
    if (!editor) return { parameters: {}, connectionBindings: {} };
    const original = JSON.parse(editor.dataset.flowFieldDefaults ?? '{}') as AgentFlowFieldDefaults;
    const definitions = JSON.parse(editor.dataset.flowFieldDefinition!) as { parameters: FormParameter[]; slots: FormParameter[] };
    try {
        const parameters = readParameterFields(editor.querySelector('[data-agent-flow-parameters]')!, definitions.parameters, fieldOptions());
        const bindings = readParameterFields(editor.querySelector('[data-agent-flow-bindings]')!, definitions.slots, fieldOptions());
        return { parameters: mergeFields(original.parameters, parameters, definitions.parameters),
            connectionBindings: mergeFields(original.connectionBindings, bindings, definitions.slots) as Record<string, string> };
    } catch (error) {
        throw new SettingsValidationError(error instanceof Error ? error.message : t('agent.execution.fields.invalidValue', { name: '' }));
    }
}

function mergeFields(
    original: Record<string, unknown> = {},
    values: Record<string, unknown>,
    parameters: FormParameter[],
): Record<string, unknown> {
    const result = Object.assign(Object.create(null), original) as Record<string, unknown>;
    parameters.forEach(parameter => { delete result[parameter.name]; });
    return Object.assign(result, values);
}
