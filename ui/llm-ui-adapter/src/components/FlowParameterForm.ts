import { escapeHTML, t } from '@itookit/common';
import { type FlowParameter, type JsonValue, validFlowImages } from '@itookit/llm-flow/contracts';
import { type ConnectionMeta } from '@itookit/driver-llm/contracts';
import { renderParameterFields, readParameterFields, type ParameterFormOptions } from '@itookit/llm-ui/forms';
import { bindFlowImageFields, imageParameterField } from './FlowImageFields';

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
        dialog.className = 'dag-dialog flow-parameter-dialog';
        dialog.setAttribute('aria-labelledby', 'flow-parameter-dialog-title');
        dialog.innerHTML = parameterDialogTemplate(parameters, title, Boolean(submit), connection, description);
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
    const inputs = parameters.length ? parameterSection('flow.parameters.title', renderParameterFields(parameters, parameterOptions(parameters))) : '';
    return inputs + (connection ? parameterSection('flow.parameters.connections', slotFields(connection) + connectionField(connection)) : '');
}

export function readFlowParameterForm(root: HTMLElement, parameters: FlowParameter[], connection?: FlowConnectionSelection): Record<string, JsonValue> {
    const values = readParameterFields(root, parameters, parameterOptions(parameters));
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
    const field = `<label class="llm-parameter-field"><span class="llm-parameter-field__label">${escapeHTML(t('connection.flowLabel'))}</span>
        <select data-run-connection><option value="">${escapeHTML(t('connection.flowInherit'))}</option>${missing}${options}</select>
        <small class="llm-parameter-field__help">${escapeHTML(t('connection.flowHint'))}</small></label>`;
    return selection.slots?.length ? `<details class="flow-parameter-connection-default" ${selection.selected ? 'open' : ''}><summary>${escapeHTML(t('connection.flowLabel'))}</summary>${field}</details>` : field;
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
        return `<label class="llm-parameter-field"><span class="llm-parameter-field__label">${escapeHTML(slot.description?.trim() || slot.name)}
            <small class="flow-parameter-section__requirement">${escapeHTML(t(slot.required === false ? 'flow.connections.optional' : 'flow.connections.required'))}</small></span>
            <select data-slot-connection="${index}"><option value="">${escapeHTML(t('connection.slotUnbound'))}</option>${missing}${options}</select>
            ${slot.requirements ? `<small class="llm-parameter-field__help">${escapeHTML(slot.requirements.operation)}</small>` : ''}</label>`;
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

function parameterDialogTemplate(
    parameters: FlowParameter[], title: string | undefined, submitting: boolean,
    connection?: FlowConnectionSelection, description?: string,
): string {
    return `<form novalidate><header class="flow-parameter-dialog__header">
        <h2 id="flow-parameter-dialog-title" tabindex="-1" autofocus>${escapeHTML(title ?? t('flow.launch.title'))}</h2>
        ${description ? `<p>${escapeHTML(description)}</p>` : ''}</header>
        <div class="flow-parameter-dialog__body">${flowParameterFields(parameters, connection)}</div>
        <footer class="flow-parameter-dialog__footer"><p data-form-error class="dag-dialog__error" role="alert"></p>
            <menu><button type="button" data-cancel>${escapeHTML(t('flow.launch.cancel'))}</button>
                <button type="submit">${escapeHTML(t(submitting ? 'flow.editor.submit' : 'flow.launch.confirm'))}</button></menu>
        </footer></form>`;
}

function parameterSection(title: Parameters<typeof t>[0], content: string): string {
    return `<section class="flow-parameter-section"><h3 class="flow-parameter-section__title">${escapeHTML(t(title))}</h3>
        <div class="flow-parameter-section__fields">${content}</div></section>`;
}

function parameterOptions(parameters: FlowParameter[]): ParameterFormOptions {
    return {
        mode: 'run',
        error: (kind, parameter) => {
            const name = parameter.label?.trim() || parameter.name;
            if (kind === 'required') return t(parameter.widget === 'images' || parameter.widget === 'select'
                ? 'flow.launch.selectionRequired' : 'flow.launch.required', { name });
            if (kind === 'number') return t('flow.launch.numberRequired');
            if (kind === 'json') return t('flow.launch.jsonRequired');
            if (kind === 'range') return t('flow.launch.numericRange', { name });
            return t('flow.launch.invalidValue');
        },
        renderField: (_parameter, index, defaultRender) => parameters[index].widget === 'images'
            ? renderImageParameter(parameters[index], index) : defaultRender(),
        parseField: (_parameter, index, _field, defaultParse) => {
            const value = defaultParse(), parameter = parameters[index];
            if (parameter.widget === 'images' && !validFlowImages(value, parameter.imageConstraints)) throw new Error(t('flow.launch.imagesInvalid'));
            return value;
        },
    };
}

function renderImageParameter(parameter: FlowParameter, index: number): string {
    const name = escapeHTML(parameter.label?.trim() || parameter.name);
    const description = parameter.description ? `<small class="llm-parameter-field__help">${escapeHTML(parameter.description)}</small>` : '';
    const label = `<span class="llm-parameter-field__label">${name}${parameter.required ? ' *' : ''}</span>${description}`;
    return imageParameterField(parameter, index, label, `data-parameter="${index}" name="${escapeHTML(parameter.name)}"`);
}
