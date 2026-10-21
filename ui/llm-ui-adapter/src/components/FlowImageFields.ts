import { escapeHTML, formatFileSize, t } from '@itookit/common';
import { validFlowImages, type FlowImageConstraints, type FlowParameter } from '@itookit/llm-flow/contracts';
import { FlowImageError, imageSelectionTrace } from './FlowImageDiagnostics';

export interface FlowImageAssetPort {import(url: string): Promise<import('@itookit/llm-flow/contracts').JsonValue>; read(reference: unknown): Promise<string>}
interface ImageField {
    root: HTMLElement; picker: HTMLInputElement; field: HTMLTextAreaElement; preview: HTMLElement;
    constraints: FlowImageConstraints; assets?: FlowImageAssetPort;
}
interface ImageWork { pending: Map<HTMLInputElement, Promise<void>>; controllers: Map<HTMLInputElement, AbortController> }

/** Stage selected files individually; durable values contain asset references. */
export function bindFlowImageFields(dialog: HTMLElement, parameters: FlowParameter[], assets?: FlowImageAssetPort): () => Promise<void> | undefined {
    const pending = new Map<HTMLInputElement, Promise<void>>(), controllers = new Map<HTMLInputElement, AbortController>();
    dialog.addEventListener('close', () => controllers.forEach(controller => controller.abort()), {once: true});
    for (const picker of dialog.querySelectorAll<HTMLInputElement>('[data-image-picker]')) {
        const constraints = parameters[Number(picker.dataset.imagePicker)].imageConstraints ?? {};
        const field = dialog.querySelector<HTMLTextAreaElement>(`[data-parameter="${picker.dataset.imagePicker}"]`)!;
        const preview = picker.parentElement!.querySelector<HTMLElement>('[data-image-preview]')!;
        void renderPreview(preview, field.value, constraints, assets);
        picker.addEventListener('change', () => selectImageFiles({root: dialog, picker, field, preview, constraints, assets}, {pending, controllers}));
        picker.parentElement!.querySelector('[data-clear-images]')!.addEventListener('click', () => {
            controllers.get(picker)?.abort();
            picker.value = ''; field.value = ''; preview.dataset.previewValue = ''; preview.replaceChildren(); pending.delete(picker);
        });
    }
    return () => pending.size ? awaitCurrent(pending) : undefined;
}

function selectImageFiles({root, picker, field, preview, constraints, assets}: ImageField, {pending, controllers}: ImageWork): void {
    controllers.get(picker)?.abort();
    const controller = new AbortController(); controllers.set(picker, controller);
    const files = Array.from(picker.files ?? []), trace = imageSelectionTrace(files, Number(picker.dataset.imagePicker), constraints);
    trace.step('selection'); preview.textContent = t('flow.launch.imagesLoading');
    const task = readImages(files, constraints, assets, controller.signal, trace).then(images => {
        if (pending.get(picker) !== task || !root.isConnected) return;
        field.value = images.length ? JSON.stringify(images) : '';
        void renderPreview(preview, field.value, constraints, assets); trace.step('ready');
    });
    pending.set(picker, task);
    void task.catch(error => {
        trace.fail(error);
        if (pending.get(picker) === task && root.isConnected) preview.textContent = imageErrorMessage(error);
    });
}

async function awaitCurrent(pending: Map<HTMLInputElement, Promise<void>>): Promise<void> {
    const current = [...pending.values()];
    await Promise.all(current);
    if ([...pending.values()].some(task => !current.includes(task))) await awaitCurrent(pending);
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
    try { return {type: 'image', source: {type: 'asset', asset: await assets.import(url)}}; }
    catch (error) {
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
    return `<label>${label}<small>${escapeHTML(hints)}</small>
        <input type="file" data-image-picker="${index}" accept="${escapeHTML(constraints.mimeTypes?.join(',') ?? 'image/*')}" multiple>
        <textarea ${attr} hidden>${escapeHTML(param.default === undefined ? '' : JSON.stringify(param.default))}</textarea>
        <span data-image-preview></span><button type="button" data-clear-images>${escapeHTML(t('flow.launch.imagesClear'))}</button></label>`;
}
