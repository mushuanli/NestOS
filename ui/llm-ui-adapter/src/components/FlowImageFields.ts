import { escapeHTML, formatFileSize, t } from '@itookit/common';
import { validFlowImages, type FlowImageConstraints, type FlowParameter } from '@itookit/llm-flow/contracts';
import { FlowImageError, imageSelectionTrace } from './FlowImageDiagnostics';

export interface FlowImageAssetPort {import(url: string): Promise<import('@itookit/llm-flow/contracts').JsonValue>; read(reference: unknown): Promise<string>}
export type FlowInitialFiles = Readonly<Record<string, readonly File[]>>;
const importedFiles = new WeakMap<FlowImageAssetPort, WeakMap<File, Promise<import('@itookit/llm-flow/contracts').JsonValue>>>();
interface ImageField {
    root: HTMLElement; picker: HTMLInputElement; field: HTMLTextAreaElement; preview: HTMLElement;
    constraints: FlowImageConstraints; assets?: FlowImageAssetPort;
}
interface ImageWork { pending: Map<HTMLInputElement, Promise<void>>; controllers: Map<HTMLInputElement, AbortController> }

/** Stage selected files individually; durable values contain asset references. */
export function bindFlowImageFields(dialog: HTMLElement, parameters: FlowParameter[], assets?: FlowImageAssetPort, initialFiles?: FlowInitialFiles): () => Promise<void> | undefined {
    const pending = new Map<HTMLInputElement, Promise<void>>(), controllers = new Map<HTMLInputElement, AbortController>();
    dialog.addEventListener('close', () => controllers.forEach(controller => controller.abort()), {once: true});
    for (const picker of dialog.querySelectorAll<HTMLInputElement>('[data-image-picker]')) {
        const parameter = parameters[Number(picker.dataset.imagePicker)];
        bindImagePicker(dialog, picker, parameter, {pending, controllers}, assets, initialFiles?.[parameter.name]);
    }
    return () => [...pending.keys()].some(picker => !picker.closest<HTMLElement>('[data-parameter-row]')?.hidden) ? awaitCurrent(pending) : undefined;
}

function bindImagePicker(root: HTMLElement, picker: HTMLInputElement, parameter: FlowParameter, work: ImageWork, assets?: FlowImageAssetPort, initial?: readonly File[]): void {
    const field = root.querySelector<HTMLTextAreaElement>(`[data-parameter="${picker.dataset.imagePicker}"]`)!;
    const row = picker.closest<HTMLElement>('.flow-parameter-image')!, preview = row.querySelector<HTMLElement>('[data-image-preview]')!;
    const constraints = parameter.imageConstraints ?? {}, dropzone = row.querySelector<HTMLElement>('[data-image-dropzone]')!;
    void renderPreview(preview, field.value, constraints, assets);
    const select = (files: File[]) => selectImageFiles({root, picker, field, preview, constraints, assets}, work, files);
    picker.addEventListener('change', () => select(Array.from(picker.files ?? [])));
    dropzone.addEventListener('dragover', event => {event.preventDefault(); dropzone.dataset.dragging = 'true';});
    dropzone.addEventListener('dragleave', () => {delete dropzone.dataset.dragging;});
    dropzone.addEventListener('drop', event => {event.preventDefault(); delete dropzone.dataset.dragging; if (!picker.disabled) select(Array.from(event.dataTransfer?.files ?? []));});
    row.querySelector('[data-clear-images]')!.addEventListener('click', () => {
        work.controllers.get(picker)?.abort();
        picker.value = ''; field.value = ''; preview.dataset.previewValue = ''; preview.replaceChildren(); work.pending.delete(picker);
        row.querySelector('[data-image-selection]')!.textContent = ''; field.dispatchEvent(new Event('input', {bubbles: true}));
    });
    if (initial?.length) select([...initial]);
}

function selectImageFiles({root, picker, field, preview, constraints, assets}: ImageField, {pending, controllers}: ImageWork, files: File[]): void {
    controllers.get(picker)?.abort();
    const controller = new AbortController(); controllers.set(picker, controller);
    const trace = imageSelectionTrace(files, Number(picker.dataset.imagePicker), constraints);
    const summary = picker.closest('.flow-parameter-image')!.querySelector('[data-image-selection]')!;
    summary.textContent = files.length ? `${t('flow.launch.imagesSelected', {count: files.length})} · ${files.map(file => file.name).join(', ')}` : '';
    trace.step('selection'); preview.textContent = t('flow.launch.imagesLoading');
    const task = readImages(files, constraints, assets, controller.signal, trace).then(images => {
        if (pending.get(picker) !== task || !root.isConnected) return;
        field.value = images.length ? JSON.stringify(images) : '';
        field.dispatchEvent(new Event('input', {bubbles: true}));
        void renderPreview(preview, field.value, constraints, assets); trace.step('ready');
    });
    pending.set(picker, task);
    void task.catch(error => {
        trace.fail(error);
        if (pending.get(picker) === task && root.isConnected) preview.textContent = imageErrorMessage(error);
    });
}

async function awaitCurrent(pending: Map<HTMLInputElement, Promise<void>>): Promise<void> {
    const active = () => [...pending].filter(([picker]) => !picker.closest<HTMLElement>('[data-parameter-row]')?.hidden).map(([, task]) => task);
    const current = active();
    await Promise.all(current.map(task => task.catch(error => {
        const picker = [...pending].find(([, pendingTask]) => pendingTask === task)?.[0];
        throw Object.assign(error instanceof Error ? error : new Error(imageErrorMessage(error)), {flowField: picker});
    })));
    if (active().some(task => !current.includes(task))) await awaitCurrent(pending);
}

async function readImages(files: File[], constraints: FlowImageConstraints, assets: FlowImageAssetPort | undefined, signal: AbortSignal, trace: ReturnType<typeof imageSelectionTrace>) {
    validateImageFiles(files, constraints);
    const parts = [];
    for (const [index, file] of files.entries()) {
        signal.throwIfAborted();
        trace.step('file-read', index);
        const url = await readFileImage(file, signal);
        signal.throwIfAborted();
        trace.step('upload', index);
        parts.push(await stageImage(file, url, assets));
    }
    signal.throwIfAborted();
    if (parts.length && !validFlowImages(parts, constraints)) throw new FlowImageError('upload-validation', 'INVALID_RECEIPT', t('flow.launch.imagesReceiptInvalid'));
    return parts;
}

function validateImageFiles(files: File[], constraints: FlowImageConstraints): void {
    if (constraints.maxItems !== undefined && files.length > constraints.maxItems)
        throw new FlowImageError('validation', 'IMAGE_COUNT', t('flow.launch.imagesCountExceeded', {count: files.length, max: constraints.maxItems}));
    const size = files.reduce((sum, file) => sum + file.size, 0);
    if (constraints.maxBytes !== undefined && size > constraints.maxBytes)
        throw new FlowImageError('validation', 'IMAGE_BYTES', t('flow.launch.imagesSizeExceeded', {size: formatFileSize(size), max: formatFileSize(constraints.maxBytes)}));
    const invalid = files.find(file => !file.type.startsWith('image/') || constraints.mimeTypes && !constraints.mimeTypes.includes(file.type));
    if (invalid) throw new FlowImageError('validation', 'IMAGE_FORMAT', t('flow.launch.imagesFormatInvalid', {
        name: invalid.name, type: invalid.type || t('flow.launch.imagesUnknownType'), formats: constraints.mimeTypes?.join(', ') ?? 'image/*'}));
}

async function stageImage(file: File, url: string, assets?: FlowImageAssetPort) {
    if (!assets) return {type: 'image_url', image_url: {url}};
    let cache = importedFiles.get(assets); if (!cache) {cache = new WeakMap(); importedFiles.set(assets, cache);}
    let receipt = cache.get(file);
    if (!receipt) {
        receipt = assets.import(url).then(asset => {
            if (!validFlowImages([{type: 'image', source: {type: 'asset', asset}}]))
                throw new FlowImageError('upload-validation', 'INVALID_RECEIPT', t('flow.launch.imagesReceiptInvalid'));
            return asset;
        });
        cache.set(file, receipt); void receipt.catch(() => cache!.delete(file));
    }
    try { return {type: 'image', source: {type: 'asset', asset: await receipt}}; }
    catch (error) {
        if (error instanceof FlowImageError) throw error;
        const {code, requestId} = (error as {code?: unknown; requestId?: unknown}) ?? {};
        throw new FlowImageError('upload', typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'UPLOAD_FAILED',
            t('flow.launch.imagesUploadFailed', {name: file.name, reason: imageErrorMessage(error)}), typeof requestId === 'string' ? requestId : undefined);
    }
}

function imageErrorMessage(error: unknown): string { return error instanceof Error ? error.message : t('flow.launch.imagesInvalid'); }

function readFileImage(file: File, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader(), abort = () => reader.abort();
        const finish = () => signal.removeEventListener('abort', abort);
        reader.onload = () => {finish(); resolve(String(reader.result));};
        reader.onerror = () => {finish(); reject(new FlowImageError('file-read', 'FILE_READ', t('flow.launch.imagesReadFailed', {name: file.name})));};
        reader.onabort = () => {finish(); reject(new DOMException('Image read cancelled', 'AbortError'));};
        signal.addEventListener('abort', abort, {once: true}); reader.readAsDataURL(file);
    });
}

async function renderPreview(root: HTMLElement, value: string, constraints: FlowImageConstraints, assets?: FlowImageAssetPort): Promise<void> {
    let images: unknown;
    try { images = JSON.parse(value); } catch { images = []; }
    root.dataset.previewValue = value;
    try {
        const urls = validFlowImages(images, constraints) ? await Promise.all(images.map(part => part.type === 'image_url'
            ? part.image_url.url : assets?.read(part.source.asset) ?? '')) : [];
        if (root.dataset.previewValue === value && root.isConnected) root.innerHTML = urls.filter(Boolean).map(url => `<img class="dag-dialog__image" src="${escapeHTML(url)}" alt="" width="96" height="96">`).join('');
    } catch (error) {if (root.dataset.previewValue === value) root.textContent = t('flow.launch.imagesPreviewFailed', {reason: imageErrorMessage(error)});}
}

export function imageParameterField(param: FlowParameter, index: number, label: string, attr: string): string {
    const constraints = param.imageConstraints ?? {};
    const hints = [constraints.maxItems === undefined ? '' : t('flow.launch.imagesMaxItems', { count: constraints.maxItems }),
        constraints.maxBytes === undefined ? '' : t('flow.launch.imagesMaxBytes', { bytes: formatFileSize(constraints.maxBytes) })].filter(Boolean).join(' · ');
    return `<div class="llm-parameter-field llm-parameter-field__wide flow-parameter-image">${label}<small class="llm-parameter-field__help">${escapeHTML(hints)}</small>
        <label class="flow-image-picker" data-image-dropzone><span>${escapeHTML(t('flow.launch.imagesDropHint'))}</span>
        <span class="flow-image-picker__action">${escapeHTML(t('flow.launch.imagesChoose'))}</span>
        <input type="file" data-image-picker="${index}" aria-label="${escapeHTML(param.label?.trim() || param.name)}" accept="${escapeHTML(constraints.mimeTypes?.join(',') ?? 'image/*')}" multiple></label>
        <textarea ${attr} hidden>${escapeHTML(param.default === undefined ? '' : JSON.stringify(param.default))}</textarea>
        <small class="llm-parameter-field__help" data-image-selection></small><span data-image-preview></span>
        <button class="flow-image-clear" type="button" data-clear-images>${escapeHTML(t('flow.launch.imagesClear'))}</button></div>`;
}
