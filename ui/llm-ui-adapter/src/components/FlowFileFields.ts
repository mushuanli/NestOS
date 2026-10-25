import {escapeHTML, formatFileSize, t} from '@itookit/common';
import {validFlowFiles, type FlowFileConstraints, type FlowParameter, type JsonValue} from '@itookit/llm-flow/contracts';
import type {FlowFileAssetPort} from './FlowFileAssetPort';
import type {FlowInitialFiles} from './FlowImageFields';

interface FileField {
    root: HTMLElement; row: HTMLElement; picker: HTMLInputElement; value: HTMLTextAreaElement; list: HTMLElement;
    retry: HTMLButtonElement; constraints: FlowFileConstraints; assets?: Partial<FlowFileAssetPort>;
    files: File[]; revision: number; controller: AbortController; pending?: Promise<void>;
}

export function bindFlowFileFields(root: HTMLElement, parameters: FlowParameter[], assets?: Partial<FlowFileAssetPort>, initial?: FlowInitialFiles): () => Promise<void> | undefined {
    const fields = [...root.querySelectorAll<HTMLInputElement>('[data-file-picker]')].map(picker => {
        const index = Number(picker.dataset.filePicker), row = picker.closest<HTMLElement>('.flow-parameter-files')!;
        const field: FileField = {root, row, picker, value: row.querySelector('textarea')!, list: row.querySelector('[data-file-list]')!,
            retry: row.querySelector('[data-retry-files]')!, constraints: parameters[index].fileConstraints ?? {}, assets,
            files: [], revision: 0, controller: new AbortController()};
        bind(field); renderList(field);
        if (initial?.[parameters[index].name]?.length) select(field, [...initial[parameters[index].name]]);
        return field;
    });
    root.addEventListener('close', () => fields.forEach(field => field.controller.abort()), {once: true});
    return () => current(fields).length ? awaitCurrent(fields) : undefined;
}

function bind(field: FileField): void {
    field.picker.disabled = !field.assets?.importFile;
    field.picker.addEventListener('change', () => select(field, [...field.picker.files ?? []]));
    field.row.querySelector('[data-clear-files]')!.addEventListener('click', () => {
        field.controller.abort(); field.revision++; field.pending = undefined; field.files = [];
        field.picker.value = ''; field.value.value = '[]'; field.retry.hidden = true; renderList(field); changed(field);
    });
    field.retry.addEventListener('click', () => select(field, field.files));
    const drop = field.row.querySelector<HTMLElement>('[data-file-dropzone]')!;
    drop.addEventListener('dragover', event => event.preventDefault());
    drop.addEventListener('drop', event => {event.preventDefault(); if (!field.picker.disabled) select(field, [...event.dataTransfer?.files ?? []]);});
}
function select(field: FileField, files: File[]): void {
    field.controller.abort(); field.controller = new AbortController(); const revision = ++field.revision;
    field.files = files; field.retry.hidden = true; field.list.textContent = t('flow.launch.filesLoading');
    const pending = prepareFiles(field, files, field.controller.signal).then(parts => {
        if (!currentField(field, revision)) return;
        field.value.value = JSON.stringify(parts); renderList(field); changed(field);
    }).catch(error => {
        if (!currentField(field, revision)) return;
        field.retry.hidden = false; field.list.textContent = fileError(error);
        throw Object.assign(new Error(fileError(error)), {flowField: field.picker});
    });
    field.pending = pending; void pending.catch(() => {});
}
async function prepareFiles(field: FileField, files: File[], signal: AbortSignal): Promise<JsonValue[]> {
    validateFiles(files, field.constraints);
    if (!field.assets?.importFile) throw new Error(t('flow.launch.filesUnavailable'));
    const parts: JsonValue[] = [];
    for (const file of files) {
        signal.throwIfAborted();
        const asset = await field.assets.importFile(file, signal);
        signal.throwIfAborted();
        parts.push({type: 'file', name: file.name, source: {type: 'asset', asset}});
    }
    if (!validFlowFiles(parts, field.constraints)) throw new Error(t('flow.launch.filesInvalid'));
    return parts;
}
function validateFiles(files: File[], constraints: FlowFileConstraints): void {
    validateCount(files.length, constraints);
    const size = files.reduce((total, file) => total + file.size, 0);
    if (constraints.maxBytes !== undefined && size > constraints.maxBytes)
        throw new Error(t('flow.launch.filesSizeExceeded', {size: formatFileSize(size), max: formatFileSize(constraints.maxBytes)}));
    const invalid = files.find(file => constraints.mimeTypes && !constraints.mimeTypes.some(mime => mime.toLowerCase() === (file.type.toLowerCase() || 'application/octet-stream')));
    if (invalid) throw new Error(t('flow.launch.filesFormatInvalid', {type: invalid.type || 'application/octet-stream', formats: constraints.mimeTypes!.join(', ')}));
}
function validateCount(count: number, constraints: FlowFileConstraints): void {
    if (count < (constraints.minItems ?? 0) || count > (constraints.maxItems ?? Number.MAX_SAFE_INTEGER))
        throw new Error(t('flow.launch.filesCountRange', {count, min: constraints.minItems ?? 0, max: constraints.maxItems ?? t('flow.launch.filesUnlimited')}));
}

function currentField(field: FileField, revision: number): boolean {return field.root.isConnected && !field.controller.signal.aborted && field.revision === revision;}
function changed(field: FileField): void {field.value.dispatchEvent(new Event('input', {bubbles: true}));}
function current(fields: FileField[]): Promise<void>[] {
    return fields.filter(field => !field.row.closest<HTMLElement>('[data-parameter-row]')?.hidden && field.pending).map(field => field.pending!);
}
async function awaitCurrent(fields: FileField[]): Promise<void> {
    const pending = current(fields); await Promise.all(pending);
    if (current(fields).some(task => !pending.includes(task))) await awaitCurrent(fields);
}
function renderList(field: FileField): void {
    try {
        const value = field.value.value.trim() ? JSON.parse(field.value.value) : [];
        if (!validFlowFiles(value)) {field.list.textContent = t('flow.launch.filesInvalid'); return;}
        field.list.textContent = [t('flow.launch.filesSelected', {count: value.length}),
            ...value.map(part => `${part.name} · ${formatFileSize(part.source.asset.bytes)}`)].join('\n');
    } catch {field.list.textContent = t('flow.launch.filesInvalid');}
}
function fileError(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? t('flow.launch.filesUploadFailed', {code})
        : error instanceof Error ? error.message : t('flow.launch.filesInvalid');
}

export function fileParameterField(parameter: FlowParameter, index: number, label: string, attr: string): string {
    const constraints = parameter.fileConstraints ?? {}, hint = constraints.maxBytes === undefined ? '' : t('flow.launch.filesMaxBytes', {bytes: formatFileSize(constraints.maxBytes)});
    return `<div class="llm-parameter-field llm-parameter-field__wide flow-parameter-files">${label}
        <small class="llm-parameter-field__help">${escapeHTML(hint)}</small>
        <label class="flow-file-picker" data-file-dropzone><span>${escapeHTML(t('flow.launch.filesDropHint'))}</span>
            <span class="flow-file-picker__action">${escapeHTML(t('flow.launch.filesChoose'))}</span>
            <input type="file" data-file-picker="${index}" aria-label="${escapeHTML(parameter.label || parameter.name)}" accept="${escapeHTML(constraints.mimeTypes?.join(',') ?? '')}" multiple></label>
        <textarea ${attr} hidden>${escapeHTML(parameter.default === undefined ? '' : JSON.stringify(parameter.default))}</textarea>
        <div class="flow-file-fields__summary" data-file-list aria-live="polite"></div>
        <div class="flow-file-fields__actions"><button type="button" data-clear-files>${escapeHTML(t('flow.launch.filesClear'))}</button>
            <button type="button" data-retry-files hidden>${escapeHTML(t('application.retry'))}</button></div></div>`;
}
