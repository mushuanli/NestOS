import { escapeHTML, t } from '@itookit/common';
import { type FlowParameter, type JsonValue } from '@itookit/llm-flow/contracts';
import { type ConnectionMeta } from '@itookit/driver-llm/contracts';

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
export interface FlowConnectionSelection {
    connections: ConnectionMeta[];
    selected?: string;
    onChange(id: string | undefined): void;
}

/** Validate before closing so invalid input can be corrected repeatedly. */
export function promptFlowParameters(parameters: FlowParameter[], title?: string, submit?: (values: Record<string, JsonValue>) => Promise<void>, signal?: AbortSignal, connection?: FlowConnectionSelection): Promise<Record<string, JsonValue> | null> {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'dag-dialog';
        dialog.innerHTML = `<form novalidate><h2>${escapeHTML(title ?? t('flow.launch.title'))}</h2>
            ${parameters.map(parameterField).join('')}
            ${connection ? connectionField(connection) : ''}
            <p data-form-error class="dag-dialog__error" role="alert"></p>
            <menu><button type="button" data-cancel>${escapeHTML(t('flow.launch.cancel'))}</button>
            <button type="submit">${escapeHTML(t(submit ? 'flow.editor.submit' : 'flow.launch.confirm'))}</button></menu></form>`;
        let result: Record<string, JsonValue> | null = null;
        dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
        let submitting = false;
        dialog.querySelector('form')!.addEventListener('submit', async event => {
            event.preventDefault();
            if (submitting) return;
            submitting = true;
            try {
                const values = collectParameters(dialog, parameters);
                if (connection) connection.onChange(dialog.querySelector<HTMLSelectElement>('[data-run-connection]')!.value || undefined);
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

function connectionField(selection: FlowConnectionSelection): string {
    const options = selection.connections.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === selection.selected ? 'selected' : ''}
        ${item.enabled === false ? 'disabled' : ''}>${escapeHTML(item.name)} · ${escapeHTML(item.providerId)}</option>`).join('');
    const missing = selection.selected && !selection.connections.some(item => item.id === selection.selected)
        ? `<option value="${escapeHTML(selection.selected)}" selected>${escapeHTML(t('connection.unavailable', { id: selection.selected }))}</option>` : '';
    return `<label>${escapeHTML(t('connection.flowLabel'))}<select data-run-connection><option value="">${escapeHTML(t('connection.flowInherit'))}</option>${missing}${options}</select>
        <small>${escapeHTML(t('connection.flowHint'))}</small></label>`;
}

function collectParameters(dialog: HTMLDialogElement, parameters: FlowParameter[]): Record<string, JsonValue> {
    const values: Record<string, JsonValue> = {};
    parameters.forEach((param, index) => {
        const field = dialog.querySelector<Field>(`[data-parameter="${index}"]`)!;
        const checkbox = field instanceof HTMLInputElement && field.type === 'checkbox';
        if (!checkbox && field.value.trim() === '') {
            if (param.required) throw new Error(t('flow.launch.required', { name: param.name }));
            return;
        }
        const value = parseParameterValue(param.type, field);
        if (typeof value === 'number' && ((param.integer && !Number.isInteger(value))
            || (param.minimum !== undefined && value < param.minimum) || (param.maximum !== undefined && value > param.maximum))) {
            throw new Error(t('flow.launch.numericRange', { name: param.name }));
        }
        values[param.name] = value;
    });
    return values;
}

function parameterField(param: FlowParameter, index: number): string {
    const name = escapeHTML(param.label ?? param.name);
    const description = param.description ? `<small>${escapeHTML(param.description)}</small>` : '';
    const label = `${name}${param.required ? ' *' : ''}${description}`;
    const attr = `data-parameter="${index}" name="${name}"`;
    if (param.widget === 'select') return `<label>${label}<select ${attr}><option value=""></option>${(param.options ?? []).map(option => `<option value="${escapeHTML(JSON.stringify(option))}" ${JSON.stringify(option) === JSON.stringify(param.default) ? 'selected' : ''}>${escapeHTML(String(option))}</option>`).join('')}</select></label>`;
    if (param.type === 'boolean') return `<label>${label}<input type="checkbox" ${attr} ${param.default === true ? 'checked' : ''}></label>`;
    const value = param.default === undefined ? '' : escapeHTML(typeof param.default === 'object'
        ? JSON.stringify(param.default) : String(param.default));
    if (param.type === 'number') return `<label>${label}<input type="number" step="${param.integer ? '1' : 'any'}"
        ${param.minimum !== undefined ? `min="${escapeHTML(String(param.minimum))}"` : ''} ${param.maximum !== undefined ? `max="${escapeHTML(String(param.maximum))}"` : ''}
        ${attr} value="${value}"></label>`;
    if (param.widget === 'text') return `<label>${label}<input type="text" ${attr} value="${value}"></label>`;
    return `<label>${label}<textarea ${attr} rows="3">${value}</textarea></label>`;
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
