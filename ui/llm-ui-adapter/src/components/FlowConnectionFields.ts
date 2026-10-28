import {updateFlowPresentationGroups} from './FlowParameterPresentation';
import {escapeHTML, t} from '@itookit/common';
import {flowConnectionRequired, type JsonValue} from '@itookit/llm-flow/contracts';
import type {ConnectionMeta} from '@itookit/driver-llm/contracts';
import type {FlowConnectionSelection} from './FlowParameterForm';
import {fieldFailure} from './FlowParameterState';

export function flowConnectionFields(selection: FlowConnectionSelection): string {
    return slotFields(selection) + connectionField(selection);
}

function connectionField(selection: FlowConnectionSelection): string {
    const options = selection.connections.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === selection.selected ? 'selected' : ''}
        ${connectionUnavailable(item) ? 'disabled' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.providerId)}</option>`).join('');
    const missing = selection.selected && !selection.connections.some(item => item.id === selection.selected)
        ? `<option value="${escapeHTML(selection.selected)}" selected>${escapeHTML(t('connection.unavailable', {id: selection.selected}))}</option>` : '';
    const field = `<label class="llm-parameter-field"><span class="llm-parameter-field__label">${escapeHTML(t('connection.flowLabel'))}</span>
        <select data-run-connection><option value="">${escapeHTML(t('connection.flowInherit'))}</option>${missing}${options}</select>
        <small class="llm-parameter-field__help">${escapeHTML(t('connection.flowHint'))}</small></label>`;
    return selection.slots?.length ? `<details class="flow-parameter-connection-default" ${selection.selected ? 'open' : ''}><summary>${escapeHTML(t('connection.flowLabel'))}</summary>${field}</details>` : field;
}

function slotFields(selection: FlowConnectionSelection): string {
    return (selection.slots ?? []).map((slot, index) => {
        const selected = selection.bindings?.[slot.name] ?? slot.connectionId;
        const missing = selected && !selection.connections.some(item => item.id === selected)
            ? `<option value="${escapeHTML(selected)}" selected>${escapeHTML(t('connection.unavailable', {id: selected}))}</option>` : '';
        const operation = slot.requirements?.operation as import('@itookit/kernel-adapters/contracts').ModelOperation | undefined;
        const compatible = selection.connections.filter(item => !operation || !item.operationModels || item.operationModels[operation] || item.id === selected);
        const options = compatible.map(item => {
            const model = operation && item.operationModels ? item.operationModels[operation] : item.tiers?.[slot.tier ?? 'optimal'] ?? item.model;
            const unsupported = operation && item.operationModels && !item.operationModels[operation];
            return `<option value="${escapeHTML(item.id)}" ${item.id === selected ? 'selected' : ''} ${unsupported || connectionUnavailable(item) ? 'disabled' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.providerId)}${model ? ` · ${escapeHTML(model)}` : ''}${unsupported ? ` · ${escapeHTML(t('modelDefaults.incompatible'))}` : ''}</option>`;
        }).join('');
        return `<label class="llm-parameter-field" data-slot-row="${index}"><span class="llm-parameter-field__label">${escapeHTML(slot.label?.trim() || slot.description?.trim() || slot.name)}
            <small class="flow-parameter-section__requirement" data-slot-requirement>${escapeHTML(t(flowConnectionRequired(slot, {}) ? 'flow.connections.required' : 'flow.connections.optional'))}</small></span>
            <select data-slot-connection="${index}"><option value="">${escapeHTML(t(flowConnectionRequired(slot, {}) ? 'connection.flowInherit' : 'connection.slotUnbound'))}</option>${missing}${options}</select>
            ${slot.description && slot.label ? `<small class="llm-parameter-field__help">${escapeHTML(slot.description)}</small>` : ''}</label>`;
    }).join('');
}

export function updateFlowConnectionRequirements(root: HTMLElement, selection: FlowConnectionSelection, values: Record<string, JsonValue>): void {
    (selection.slots ?? []).forEach((slot, index) => {
        const required = flowConnectionRequired(slot, values), row = root.querySelector<HTMLElement>(`[data-slot-row="${index}"]`);
        if (row) row.hidden = !!slot.requiredWhen && !required;
        row?.querySelector('[data-slot-requirement]')?.replaceChildren(t(required ? 'flow.connections.required' : 'flow.connections.optional'));
        row?.querySelector('select')?.setAttribute('aria-required', String(required));
        row?.querySelector('option[value=""]')?.replaceChildren(t(required ? 'connection.flowInherit' : 'connection.slotUnbound'));
    });
    updateFlowPresentationGroups(root);
}

export function collectFlowConnections(root: HTMLElement, selection: FlowConnectionSelection, values: Record<string, JsonValue>): void {
    const bindings: Record<string, string> = Object.fromEntries(Object.entries(selection.bindings ?? {}).filter(([name]) => name.includes('/')));
    (selection.slots ?? []).forEach((slot, index) => {
        const field = root.querySelector<HTMLSelectElement>(`[data-slot-connection="${index}"]`)!, id = field.value;
        try {validateConnection(selection, id);} catch (error) {throw fieldFailure(field, (error as Error).message);}
        if (id || !flowConnectionRequired(slot, values) && (slot.connectionId || Object.hasOwn(selection.bindings ?? {}, slot.name))) bindings[slot.name] = id;
    });
    const field = root.querySelector<HTMLSelectElement>('[data-run-connection]')!, selected = field.value;
    try {validateConnection(selection, selected);} catch (error) {throw fieldFailure(field, (error as Error).message);}
    selection.bindings = bindings; selection.onChange(selected || undefined);
}

export async function validateFlowConnectionForm(root: HTMLElement, selection: FlowConnectionSelection | undefined, values: Record<string, JsonValue>): Promise<void> {
    try {await selection?.validate?.(values);}
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const name = (error as {field?: unknown})?.field;
        const slot = selection?.slots?.findIndex(item => item.name === name);
        const field = slot !== undefined && slot >= 0 ? root.querySelector<HTMLElement>(`[data-slot-connection="${slot}"]`) : undefined;
        if (field) throw fieldFailure(field, message);
        throw error;
    }
}

function connectionUnavailable(connection: ConnectionMeta): boolean {
    return connection.enabled === false || connection.credentialsReady === false
        || connection.credentialsReady === undefined && connection.hasApiKey === false;
}

function validateConnection(selection: FlowConnectionSelection, id: string): void {
    if (!id) return;
    const connection = selection.connections.find(item => item.id === id);
    if (!connection || connectionUnavailable(connection)) throw new Error(t('connection.unavailable', {id}));
}
