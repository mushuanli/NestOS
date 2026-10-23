import { escapeHTML, t } from '@itookit/common';
import { type FlowInputGroup, type FlowParameter, type JsonValue, validFlowImages } from '@itookit/llm-flow/contracts';
import { type ConnectionMeta } from '@itookit/driver-llm/contracts';
import { renderParameterFields, readParameterFields, type ParameterFormOptions } from '@itookit/llm-ui/forms';
import { bindFlowImageFields, imageParameterField, type FlowInitialFiles } from './FlowImageFields';
import {bindFlowParameterState, readSelectedFlowParameters, renderFlowInputGroups, showFlowFieldError} from './FlowParameterState';
import {collectFlowConnections, flowConnectionFields, updateFlowConnectionRequirements, validateFlowConnectionForm} from './FlowConnectionFields';

export {bindFlowParameterState, showFlowFieldError, validateFlowConnectionForm};

export interface FlowConnectionSelection {
    assets?: import('./FlowImageFields').FlowImageAssetPort;
    connections: Array<ConnectionMeta & { operationModels?: Partial<Record<import('@itookit/kernel-adapters/contracts').ModelOperation, string>> }>;
    slots?: import('@itookit/llm-flow/contracts').FlowConnection[];
    bindings?: Record<string, string>;
    selected?: string;
    onChange(id: string | undefined): void;
    validate?(values?: Record<string, JsonValue>): Promise<void>;
}
export interface FlowParameterExtension {
    initialFiles?: FlowInitialFiles;
    inputGroups?: readonly FlowInputGroup[];
    mount?(dialog: HTMLElement): () => void;
    validate?(): void;
    submitLabel?: Parameters<typeof t>[0];
    formatError?(error: unknown): string;
    withSubmissionSignal?: boolean;
}

/** Validate before closing so invalid input can be corrected repeatedly. */
export function promptFlowParameters(parameters: FlowParameter[], title?: string, submit?: (values: Record<string, JsonValue>, signal?: AbortSignal) => Promise<void>, signal?: AbortSignal, connection?: FlowConnectionSelection, assets = connection?.assets, description?: string, extension?: FlowParameterExtension): Promise<Record<string, JsonValue> | null> {
    return new Promise(resolve => {
        const lifetime = new AbortController();
        const {dialog, imagesReady, unmount} = mountParameterDialog(parameters, title, Boolean(submit), connection, assets, description, extension);
        const isCurrent = () => !lifetime.signal.aborted && !signal?.aborted;
        const collect = () => {
            if (!isCurrent()) throw new Error(t('flow.launch.cancel'));
            extension?.validate?.();
            const values = readFlowParameterForm(dialog, parameters, connection);
            return connection?.validate ? validateFlowConnectionForm(dialog, connection, values).then(() => values) : values;
        };
        const read = () => { const pending = imagesReady(); return pending ? pending.then(collect) : collect(); };
        const result = bindParameterSubmission(dialog, read, submit, lifetime.signal, isCurrent, extension);
        dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
        const abort = () => dialog.close(); signal?.addEventListener('abort', abort, {once: true});
        dialog.addEventListener('close', () => {
            const values = signal?.aborted ? null : result();
            lifetime.abort(); signal?.removeEventListener('abort', abort); unmount(); dialog.remove(); resolve(values);
        }, {once: true});
        document.body.append(dialog); dialog.showModal(); if (signal?.aborted) abort();
    });
}

function mountParameterDialog(parameters: FlowParameter[], title: string | undefined, submitting: boolean,
    connection?: FlowConnectionSelection, assets?: FlowConnectionSelection['assets'], description?: string, extension?: FlowParameterExtension) {
    const dialog = document.createElement('dialog'); dialog.className = 'dag-dialog flow-parameter-dialog';
    dialog.setAttribute('aria-labelledby', 'flow-parameter-dialog-title');
    dialog.innerHTML = parameterDialogTemplate(parameters, title, submitting, connection, description, extension?.inputGroups);
    const unbind = bindFlowParameterState(dialog, parameters, extension?.inputGroups ?? [], values => {
        if (connection) updateFlowConnectionRequirements(dialog, connection, values);
    });
    const imagesReady = bindFlowImageFields(dialog, parameters, assets, extension?.initialFiles), unmount = extension?.mount?.(dialog);
    if (extension?.submitLabel) dialog.querySelector('button[type="submit"]')!.textContent = t(extension.submitLabel);
    return {dialog, imagesReady, unmount: () => {unmount?.(); unbind();}};
}

function bindParameterSubmission(dialog: HTMLElement, read: () => Record<string, JsonValue> | Promise<Record<string, JsonValue>>,
    submit: ((values: Record<string, JsonValue>, signal?: AbortSignal) => Promise<void>) | undefined,
    signal: AbortSignal, isCurrent: () => boolean, extension?: FlowParameterExtension): () => Record<string, JsonValue> | null {
    let submitting = false, result: Record<string, JsonValue> | null = null;
    dialog.querySelector('form')!.addEventListener('submit', async event => {
        event.preventDefault(); if (submitting || !isCurrent()) return;
        submitting = true;
        const restore = freezeParameterControls(dialog);
        try {
            const pending = read(), values = pending instanceof Promise ? await pending : pending;
            if (!isCurrent()) return;
            await (extension?.withSubmissionSignal ? submit?.(values, signal) : submit?.(values));
            if (!isCurrent()) return;
            result = values; (dialog as HTMLDialogElement).close();
        } catch (error) {
            if (isCurrent()) {
                restore(); showFlowFieldError(dialog, error);
                dialog.querySelector('[data-form-error]')!.textContent = extension?.formatError?.(error)
                    ?? (error instanceof Error ? error.message : t('flow.launch.invalidValue'));
            }
        } finally { submitting = false; restore(); }
    });
    return () => result;
}

function freezeParameterControls(dialog: HTMLElement): () => void {
    const controls = [...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button')]
        .filter(control => !control.hasAttribute('data-cancel')).map(control => ({control, disabled: control.disabled}));
    controls.forEach(({control}) => {control.disabled = true;});
    return () => controls.forEach(({control, disabled}) => {control.disabled = disabled;});
}

export function flowParameterFields(parameters: FlowParameter[], connection?: FlowConnectionSelection, groups: readonly FlowInputGroup[] = []): string {
    const inputs = parameters.length ? parameterSection('flow.parameters.inputs', renderFlowInputGroups(parameters, groups)
        + renderParameterFields(parameters, parameterOptions(parameters))) : '';
    return inputs + (connection ? parameterSection('flow.parameters.connections', flowConnectionFields(connection)) : '');
}

export function readFlowParameterForm(root: HTMLElement, parameters: FlowParameter[], connection?: FlowConnectionSelection): Record<string, JsonValue> {
    const values = readSelectedFlowParameters(root, parameters, (field, parameter) => readParameterFields(field, [parameter], parameterOptions([parameter])));
    if (connection) collectFlowConnections(root, connection, values);
    return values;
}

function parameterDialogTemplate(
    parameters: FlowParameter[], title: string | undefined, submitting: boolean,
    connection?: FlowConnectionSelection, description?: string, groups?: readonly FlowInputGroup[],
): string {
    return `<form novalidate><header class="flow-parameter-dialog__header">
        <h2 id="flow-parameter-dialog-title" tabindex="-1" autofocus>${escapeHTML(title ?? t('flow.launch.title'))}</h2>
        ${description ? `<p>${escapeHTML(description)}</p>` : ''}</header>
        <div class="flow-parameter-dialog__body">${flowParameterFields(parameters, connection, groups)}</div>
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
        labels: {required: ''},
        error: (kind, parameter) => {
            const name = parameter.label?.trim() || parameter.name;
            if (kind === 'required') return t(parameter.widget === 'images' || parameter.widget === 'select'
                ? 'flow.launch.selectionRequired' : 'flow.launch.required', { name });
            if (kind === 'number') return t('flow.launch.numberRequired');
            if (kind === 'json') return t('flow.launch.jsonRequired');
            if (kind === 'range') return t('flow.launch.numericRange', { name });
            return t('flow.launch.invalidValue');
        },
        renderField: (_parameter, index, defaultRender) => {
            const parameter = parameters[index], content = parameter.widget === 'images' ? renderImageParameter(parameter, index) : defaultRender();
            const requirement = `<small class="flow-parameter-section__requirement" data-parameter-requirement>${escapeHTML(t(parameter.required ? 'flow.parameters.required' : 'flow.parameters.optional'))}</small>`;
            return `<div class="flow-parameter-row${parameter.type === 'json' || parameter.type === 'string' && parameter.widget !== 'text' && !parameter.options?.length ? ' flow-parameter-row--wide' : ''}" data-parameter-row="${index}">${content.replace('</span>', requirement + '</span>')}</div>`;
        },
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
    const label = `<span class="llm-parameter-field__label">${name}</span>${description}`;
    return imageParameterField(parameter, index, label, `data-parameter="${index}" name="${escapeHTML(parameter.name)}"`);
}
