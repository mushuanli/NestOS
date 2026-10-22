import { escapeHTML, t } from '@itookit/common';
import { type FlowParameter, type JsonValue, validFlowImages } from '@itookit/llm-flow/contracts';
import { type ConnectionMeta } from '@itookit/driver-llm/contracts';
import { bindFlowImageFields, imageParameterField } from './FlowImageFields';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export interface FlowConnectionSelection {
    assets?: import('./FlowImageFields').FlowImageAssetPort;
    connections: Array<ConnectionMeta & { operationModels?: Partial<Record<import('@itookit/kernel-adapters/contracts').ModelOperation, string>> }>;
    slots?: import('@itookit/llm-flow/contracts').FlowConnection[];
    bindings?: Record<string, string>;
    selected?: string;
    onChange(id: string | undefined): void;
    validate?(): Promise<void>;
}

/** Validate before closing so invalid input can be corrected repeatedly. */
export function promptFlowParameters(parameters: FlowParameter[], title?: string, submit?: (values: Record<string, JsonValue>) => Promise<void>, signal?: AbortSignal, connection?: FlowConnectionSelection, assets = connection?.assets, description?: string): Promise<Record<string, JsonValue> | null> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'dag-dialog';
        dialog.innerHTML = `<form novalidate><h2>${escapeHTML(title ?? t('flow.launch.title'))}</h2>
            ${description ? `<p>${escapeHTML(description)}</p>` : ''}
            ${flowParameterFields(parameters, connection)}
            <p data-form-error class="dag-dialog__error" role="alert"></p>
            <menu><button type="button" data-cancel>${escapeHTML(t('flow.launch.cancel'))}</button>
            <button type="submit">${escapeHTML(t(submit ? 'flow.editor.submit' : 'flow.launch.confirm'))}</button></menu></form>`;
        let result: Record<string, JsonValue> | null = null;
        const imagesReady = bindFlowImageFields(dialog, parameters, assets);
        dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
        let submitting = false;
        dialog.querySelector('form')!.addEventListener('submit', async event => {
            event.preventDefault();
            if (submitting) return;
            submitting = true;
            try {
                const pendingImages = imagesReady();
                if (pendingImages) await pendingImages;
                if (signal?.aborted || !dialog.isConnected) return;
                const values = readFlowParameterForm(dialog, parameters, connection);
                if (connection?.validate) await connection.validate();
                if (signal?.aborted || !dialog.isConnected) return;
                await submit?.(values); result = values; dialog.close();
            }
            catch (error) { dialog.querySelector('[data-form-error]')!.textContent =
                error instanceof Error ? error.message : t('flow.launch.invalidValue'); }
            finally { submitting = false; }
        });
        const abort = () => { result = null; dialog.close(); };
        signal?.addEventListener('abort', abort, { once: true });
        dialog.addEventListener('close', () => { signal?.removeEventListener('abort', abort); dialog.remove(); resolve(result); }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        if (signal?.aborted) abort();
    });
}

export function flowParameterFields(parameters: FlowParameter[], connection?: FlowConnectionSelection): string {
    return parameters.map(parameterField).join('') + (connection ? slotFields(connection) + connectionField(connection) : '');
}

export function readFlowParameterForm(root: HTMLElement, parameters: FlowParameter[], connection?: FlowConnectionSelection): Record<string, JsonValue> {
    const values = collectParameters(root, parameters);
    if (connection) {
        collectConnections(root, connection);
        const selected = root.querySelector<HTMLSelectElement>('[data-run-connection]')!.value;
        validateConnection(connection, selected);
        connection.onChange(selected || undefined);
    }
    return values;
}

function connectionField(selection: FlowConnectionSelection): string {
    const options = selection.connections.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === selection.selected ? 'selected' : ''}
        ${connectionUnavailable(item) ? 'disabled' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.providerId)}</option>`).join('');
    const missing = selection.selected && !selection.connections.some(item => item.id === selection.selected)
        ? `<option value="${escapeHTML(selection.selected)}" selected>${escapeHTML(t('connection.unavailable', { id: selection.selected }))}</option>` : '';
    const field = `<label>${escapeHTML(t('connection.flowLabel'))}<select data-run-connection><option value="">${escapeHTML(t('connection.flowInherit'))}</option>${missing}${options}</select>
        <small>${escapeHTML(t('connection.flowHint'))}</small></label>`;
    return selection.slots?.length ? `<details ${selection.selected ? 'open' : ''}><summary>${escapeHTML(t('connection.flowLabel'))}</summary>${field}</details>` : field;
}

function slotFields(selection: FlowConnectionSelection): string {
    return (selection.slots ?? []).map((slot, index) => {
        const selected = selection.bindings?.[slot.name] ?? slot.connectionId;
        const missing = selected && !selection.connections.some(item => item.id === selected)
            ? `<option value="${escapeHTML(selected)}" selected>${escapeHTML(t('connection.unavailable', { id: selected }))}</option>` : '';
        const operation = slot.requirements?.operation as import('@itookit/kernel-adapters/contracts').ModelOperation | undefined;
        const compatible = selection.connections.filter(item => !operation || !item.operationModels || item.operationModels[operation] || item.id === selected);
        const options = compatible.map(item => {
            const model = operation && item.operationModels ? item.operationModels[operation] : item.tiers?.[slot.tier ?? 'optimal'] ?? item.model;
            const unsupported = operation && item.operationModels && !item.operationModels[operation];
            return `<option value="${escapeHTML(item.id)}" ${item.id === selected ? 'selected' : ''} ${unsupported || connectionUnavailable(item) ? 'disabled' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.providerId)}${model ? ` · ${escapeHTML(model)}` : ''}${unsupported ? ` · ${escapeHTML(t('modelDefaults.incompatible'))}` : ''}</option>`;
        }).join('');
        return `<label>${escapeHTML(slot.description?.trim() || slot.name)} · ${escapeHTML(t(slot.required === false ? 'flow.connections.optional' : 'flow.connections.required'))}${slot.requirements ? ` · ${escapeHTML(slot.requirements.operation)}` : ''}<select data-slot-connection="${index}"><option value="">${escapeHTML(t('connection.slotUnbound'))}</option>${missing}${options}</select></label>`;
    }).join('');
}
function collectConnections(dialog: HTMLElement, selection: FlowConnectionSelection): void {
    const bindings: Record<string, string> = Object.fromEntries(Object.entries(selection.bindings ?? {}).filter(([name]) => name.includes('/')));
    (selection.slots ?? []).forEach((slot, index) => {
        const id = dialog.querySelector<HTMLSelectElement>(`[data-slot-connection="${index}"]`)!.value;
        if (!id && slot.required !== false) throw new Error(t('flow.launch.connectionRequired', { name: slot.description?.trim() || slot.name }));
        validateConnection(selection, id);
        if (id || slot.connectionId || Object.hasOwn(selection.bindings ?? {}, slot.name)) bindings[slot.name] = id;
    });
    selection.bindings = bindings;
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

function collectParameters(dialog: HTMLElement, parameters: FlowParameter[]): Record<string, JsonValue> {
    const values: Record<string, JsonValue> = {};
    parameters.forEach((param, index) => {
        const field = dialog.querySelector<Field>(`[data-parameter="${index}"]`)!;
        const checkbox = field instanceof HTMLInputElement && field.type === 'checkbox';
        if (!checkbox && field.value.trim() === '') {
            if (param.required) throw new Error(t(param.widget === 'images' || param.widget === 'select' ? 'flow.launch.selectionRequired' : 'flow.launch.required', { name: param.label?.trim() || param.name }));
            return;
        }
        const value = parseParameterValue(param.type, field);
        if (param.widget === 'images' && !validFlowImages(value, param.imageConstraints)) throw new Error(t('flow.launch.imagesInvalid'));
        if (typeof value === 'number' && ((param.integer && !Number.isInteger(value))
            || (param.minimum !== undefined && value < param.minimum) || (param.maximum !== undefined && value > param.maximum))) {
            throw new Error(t('flow.launch.numericRange', { name: param.label?.trim() || param.name }));
        }
        values[param.name] = value;
    });
    return values;
}

function parameterField(param: FlowParameter, index: number): string {
    const name = escapeHTML(param.label?.trim() || param.name);
    const description = param.description ? `<small>${escapeHTML(param.description)}</small>` : '';
    const label = `${name}${param.required ? ' *' : ''}${description}`;
    const attr = `data-parameter="${index}" name="${name}"`;
    if (param.widget === 'images') return imageParameterField(param, index, label, attr);
    if (param.widget === 'select') return `<label>${label}<select ${attr}><option value=""></option>${(param.options ?? []).map(option => `<option value="${escapeHTML(JSON.stringify(option))}" ${JSON.stringify(option) === JSON.stringify(param.default) ? 'selected' : ''}>${escapeHTML(String(option))}</option>`).join('')}</select></label>`;
    if (param.type === 'boolean') return `<label>${label}<input type="checkbox" ${attr} ${param.default === true ? 'checked' : ''}></label>`;
    const value = param.default === undefined ? '' : escapeHTML(typeof param.default === 'object'
        ? JSON.stringify(param.default, null, 2) : String(param.default));
    if (param.type === 'number') return `<label>${label}<input type="number" step="${param.integer ? '1' : 'any'}"
        ${param.minimum !== undefined ? `min="${escapeHTML(String(param.minimum))}"` : ''} ${param.maximum !== undefined ? `max="${escapeHTML(String(param.maximum))}"` : ''}
        ${attr} value="${value}"></label>`;
    if (param.widget === 'text') return `<label>${label}<input type="text" ${attr} value="${value}"></label>`;
    return `<label>${label}<textarea ${attr} rows="${param.type === 'json' ? 8 : 3}">${value}</textarea></label>`;
}

function parseParameterValue(type: FlowParameter['type'], field: Field): JsonValue {
    if (field instanceof HTMLSelectElement) return JSON.parse(field.value) as JsonValue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') return field.checked;
    if (type === 'number') {
        const value = Number(field.value);
        if (!Number.isFinite(value)) throw new Error(t('flow.launch.numberRequired'));
        return value;
    }
    if (type === 'json') {
        try { return JSON.parse(field.value) as JsonValue; }
        catch { throw new Error(t('flow.launch.jsonRequired')); }
    }
    return field.value;
}
