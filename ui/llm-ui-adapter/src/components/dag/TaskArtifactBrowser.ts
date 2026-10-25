import {escapeHTML, randomUUID, t} from '@itookit/common';
import {ArtifactCommand, type ExecutionArtifactDescriptor, type ExecutionArtifactPage, type ExecutionArtifactScope} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {readArtifactContent} from './artifact-content';

interface ItemState {artifact: ExecutionArtifactDescriptor; pending?: boolean; error?: string; text?: string; url?: string; truncated?: boolean;}
interface CatalogState {controller: AbortController; scope: ExecutionArtifactScope; items: ItemState[]; loaded?: boolean; pending?: boolean; error?: string; nextOffset?: number;}
export interface ArtifactBrowserOptions {maxDownloadBytes?: number; previewBytes?: number;}

/** One view owns its read state and URLs; rerenders never restart reads or cross task scopes. */
export class TaskArtifactBrowser {
    private readonly ownerId = randomUUID();
    private readonly catalogs = new Map<string, CatalogState>();
    private readonly urls = new Set<string>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private visible = true;
    private disposed = false;
    private readonly onClick = (event: Event) => {void this.click(event);};
    constructor(private readonly root: HTMLElement, private readonly commands: ICommandBus, private readonly options: ArtifactBrowserOptions = {}) {
        root.addEventListener('click', this.onClick);
    }

    render(scope: ExecutionArtifactScope): string {
        if (this.disposed) return '';
        const key = JSON.stringify([scope.sessionId, scope.taskId]);
        if (!this.catalogs.has(key)) this.catalogs.set(key, {controller: new AbortController(), scope: {...scope}, items: []});
        return `<div class="dag-artifacts" data-artifact-owner="${this.ownerId}" data-artifact-scope="${escapeHTML(key)}">${this.contents(this.catalogs.get(key)!)}</div>`;
    }

    clear(): void {
        for (const state of this.catalogs.values()) state.controller.abort(); this.catalogs.clear();
        for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
        for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear();
    }
    dispose(): void {this.disposed = true; this.clear(); this.root.removeEventListener('click', this.onClick);}

    setVisible(visible: boolean): void {
        if (this.visible === visible || this.disposed) return;
        this.visible = visible;
        if (visible) return;
        const scopes = [...this.catalogs.values()].map(state => state.scope); this.clear();
        for (const scope of scopes) {this.render(scope); this.update(JSON.stringify([scope.sessionId, scope.taskId]));}
    }

    prune(): void {
        const retained = new Set([...this.root.querySelectorAll<HTMLElement>('[data-artifact-scope]')]
            .filter(el => el.dataset.artifactOwner === this.ownerId && !el.closest('.llm-ui-session--deleting'))
            .map(el => el.dataset.artifactScope));
        for (const [key, state] of this.catalogs) if (!retained.has(key)) {
            state.controller.abort(); this.catalogs.delete(key);
            for (const item of state.items) if (item.url) {URL.revokeObjectURL(item.url); this.urls.delete(item.url);}
        }
    }

    private contents(state: CatalogState): string {
        const label = state.pending ? 'flow.artifacts.loading' : state.loaded ? 'flow.artifacts.more' : 'flow.artifacts.open';
        return `${!state.loaded || state.nextOffset !== undefined ? `<button type="button" data-artifacts-load ${state.pending ? 'disabled' : ''}>${escapeHTML(t(label))}</button>` : ''}
            ${state.error ? `<p role="alert">${escapeHTML(state.error)}</p>` : ''}
            ${state.loaded && !state.items.length ? `<p>${escapeHTML(t('flow.artifacts.empty'))}</p>` : ''}
            ${state.items.map((item, index) => this.item(item, index)).join('')}`;
    }

    private item(item: ItemState, index: number): string {
        const value = item.artifact;
        return `<section class="dag-artifacts__item"><strong>${escapeHTML(value.name)}</strong>
            <small>${escapeHTML(value.mimeType)}${value.bytes !== undefined ? ` · ${value.bytes} B` : ''}</small>
            ${this.actions(item, index)}${this.preview(item)}</section>`;
    }

    private actions(item: ItemState, index: number): string {
        if (item.artifact.kind === 'unavailable') return `<p>${escapeHTML(t('flow.artifacts.notImported'))}</p>`;
        const preview = item.artifact.kind === 'text' || item.artifact.kind === 'json' || /^image\/(png|jpeg|webp|gif)$/.test(item.artifact.mimeType);
        return `<button type="button" data-artifact-download="${index}" ${item.pending ? 'disabled' : ''}>${escapeHTML(t('flow.artifacts.download'))}</button>
            ${preview ? `<button type="button" data-artifact-preview="${index}" ${item.pending ? 'disabled' : ''}>${escapeHTML(t('flow.artifacts.preview'))}</button>` : ''}`;
    }

    private preview(item: ItemState): string {
        return `${item.error ? `<p role="alert">${escapeHTML(item.error)}</p>` : ''}
            ${item.text !== undefined ? `<pre>${escapeHTML(item.text)}</pre>` : ''}
            ${item.url ? `<img src="${escapeHTML(item.url)}" alt="${escapeHTML(item.artifact.name)}" style="max-width:100%">` : ''}
            ${item.truncated ? `<small>${escapeHTML(t('flow.artifacts.truncated'))}</small>` : ''}`;
    }

    private async click(event: Event): Promise<void> {
        if (!(event.target instanceof Element)) return;
        const button = (event.target as Element).closest<HTMLButtonElement>('[data-artifacts-load], [data-artifact-download], [data-artifact-preview]');
        const container = button?.closest<HTMLElement>('[data-artifact-scope]');
        if (container?.dataset.artifactOwner !== this.ownerId) return;
        const key = container.dataset.artifactScope;
        if (!button || !key || this.disposed || !this.visible) return;
        const state = this.catalogs.get(key); if (!state) return;
        if (button.hasAttribute('data-artifacts-load')) return this.load(key, state);
        const download = button.dataset.artifactDownload !== undefined;
        const item = state.items[Number(download ? button.dataset.artifactDownload : button.dataset.artifactPreview)];
        if (item) await this.read(key, state, item, download);
    }

    private async load(key: string, state: CatalogState): Promise<void> {
        if (state.pending) return; const signal = state.controller.signal;
        state.pending = true; state.error = undefined; this.update(key);
        try {
            const page = await this.commands.execute<ExecutionArtifactPage>(ArtifactCommand.List, {...state.scope, offset: state.nextOffset ?? 0, limit: 20});
            signal.throwIfAborted();
            if (!validPage(page, state)) throw Object.assign(new Error(), {code: 'ARTIFACT_RESPONSE_INVALID'});
            const seen = new Set(state.items.map(item => item.artifact.reference.artifactId));
            for (const artifact of page.items) {if (!seen.has(artifact.reference.artifactId)) {state.items.push({artifact}); seen.add(artifact.reference.artifactId);}}
            state.loaded = true; state.nextOffset = page.nextOffset;
        } catch (error) {if (!signal.aborted) state.error = errorText(error);}
        finally {state.pending = false; if (!signal.aborted) this.update(key);}
    }

    private async read(key: string, state: CatalogState, item: ItemState, download: boolean): Promise<void> {
        if (item.pending) return; const signal = state.controller.signal;
        item.pending = true; item.error = undefined; this.update(key);
        try {
            const result = await readArtifactContent(this.commands, item.artifact, this.readOptions(item.artifact, download, signal));
            signal.throwIfAborted(); this.applyContent(item, result, download);
        } catch (error) {if (!signal.aborted) item.error = errorText(error);}
        finally {item.pending = false; if (!signal.aborted) this.update(key);}
    }

    private readOptions(artifact: ExecutionArtifactDescriptor, download: boolean, signal: AbortSignal) {
        const preview = !download && !/^image\//.test(artifact.mimeType);
        return {signal, maxBytes: this.options.maxDownloadBytes ?? 32 * 1024 * 1024,
            ...(preview ? {previewBytes: this.options.previewBytes ?? 64 * 1024} : {})};
    }

    private applyContent(item: ItemState, result: {bytes: Uint8Array; truncated: boolean}, download: boolean): void {
        if (download) return this.download(result.bytes, item.artifact);
        if (/^image\//.test(item.artifact.mimeType)) {
            if (item.url) {URL.revokeObjectURL(item.url); this.urls.delete(item.url);}
            item.url = this.url(result.bytes, item.artifact.mimeType);
        } else {item.text = new TextDecoder().decode(result.bytes, {stream: result.truncated}); item.truncated = result.truncated;}
    }

    private url(bytes: Uint8Array, mimeType: string): string {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], {type: mimeType})); this.urls.add(url); return url;
    }
    private download(bytes: Uint8Array, artifact: ExecutionArtifactDescriptor): void {
        const url = this.url(bytes, artifact.mimeType), link = document.createElement('a');
        link.href = url; link.download = artifact.name; this.root.append(link); link.click(); link.remove();
        const timer = setTimeout(() => {URL.revokeObjectURL(url); this.urls.delete(url); this.timers.delete(timer);}, 1000); this.timers.add(timer);
    }
    private update(key: string): void {
        if (this.disposed) return;
        for (const element of this.root.querySelectorAll<HTMLElement>('[data-artifact-scope]')) {
            if (element.dataset.artifactOwner === this.ownerId && element.dataset.artifactScope === key) element.innerHTML = this.contents(this.catalogs.get(key)!);
        }
    }
}

function errorText(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return t('flow.artifacts.failed', {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ARTIFACT_READ_FAILED'});
}

function validPage(page: ExecutionArtifactPage, state: CatalogState): boolean {
    if (!page || page.sessionId !== state.scope.sessionId || page.taskId !== state.scope.taskId) return false;
    if (!Array.isArray(page.items) || page.items.length > 20) return false;
    if (page.nextOffset !== undefined && (!page.items.length || page.nextOffset !== (state.nextOffset ?? 0) + page.items.length)) return false;
    return page.items.every(item => validItemScope(item, state.scope));
}
function validItemScope(item: ExecutionArtifactDescriptor, scope: ExecutionArtifactScope): boolean {
    return !!item && item.reference?.kind === 'task-output' && item.reference.sessionId === scope.sessionId
        && item.reference.taskId === scope.taskId && item.taskId === scope.taskId && typeof item.reference.artifactId === 'string'
        && !!item.reference.artifactId && typeof item.name === 'string' && typeof item.mimeType === 'string'
        && typeof item.outputName === 'string' && ['text', 'json', 'binary', 'unavailable'].includes(item.kind)
        && (item.kind === 'unavailable' || Number.isSafeInteger(item.bytes) && item.bytes! >= 0
            && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256));
}
