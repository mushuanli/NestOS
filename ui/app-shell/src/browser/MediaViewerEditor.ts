/**
 * @file app-shell/src/browser/MediaViewerEditor.ts
 *
 * 轻量多媒体查看器，实现 IEditor 接口。
 * 用于替代文本编辑器来预览图片、视频、音频、PDF 等二进制文件。
 * 始终处于只读渲染模式，不提供编辑能力。
 */
import { EventBus } from '@itookit/vfs-core';
import type {Heading} from '@itookit/common';
import type { IEditor, EditorEvent, EditorEventMap, EditorEventCallback, UnifiedSearchResult, CollapseExpandResult } from '@itookit/ui-common';

// ── MIME 类型分组 ──────────────────────────────────────────────────────────────

const IMAGE_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/tiff',
]);
const VIDEO_TYPES = new Set([
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
    'video/x-matroska',
]);
const AUDIO_TYPES = new Set([
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac',
    'audio/aac', 'audio/mp4',
]);
const PDF_TYPE = 'application/pdf';

export function isBinaryViewable(mimeType: string): boolean {
    return IMAGE_TYPES.has(mimeType)
        || VIDEO_TYPES.has(mimeType)
        || AUDIO_TYPES.has(mimeType)
        || mimeType === PDF_TYPE;
}

// ── Editor 实现 ────────────────────────────────────────────────────────────────

export class MediaViewerEditor implements IEditor {
    private objectUrl: string | null = null;
    private editorEvents = new EventBus<EditorEventMap>();

    constructor(private readonly mimeType: string) {}

    async init(container: HTMLElement, initialContent?: string | ArrayBuffer): Promise<void> {
        container.innerHTML = '';
        container.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:var(--bg-secondary,#f5f5f5);overflow:auto;';

        if (!initialContent) {
            container.innerHTML = '<div style="color:#999;padding:2rem;">无法读取文件内容</div>';
            return;
        }

        // Convert content → blob URL
        let src: string;
        if (initialContent instanceof ArrayBuffer) {
            const blob = new Blob([initialContent], { type: this.mimeType });
            this.objectUrl = URL.createObjectURL(blob);
            src = this.objectUrl;
        } else {
            // String content: might be a data URL already, or base64
            if (typeof initialContent === 'string' && initialContent.startsWith('data:')) {
                src = initialContent;
            } else {
                // Encode raw string as data URL (e.g. SVG stored as text)
                const blob = new Blob([initialContent], { type: this.mimeType });
                this.objectUrl = URL.createObjectURL(blob);
                src = this.objectUrl;
            }
        }

        // Render based on MIME category
        if (IMAGE_TYPES.has(this.mimeType)) {
            this.renderImage(container, src);
        } else if (VIDEO_TYPES.has(this.mimeType)) {
            this.renderVideo(container, src);
        } else if (AUDIO_TYPES.has(this.mimeType)) {
            this.renderAudio(container, src);
        } else if (this.mimeType === PDF_TYPE) {
            this.renderPdf(container, src);
        }
    }

    private renderImage(container: HTMLElement, src: string): void {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;max-width:100%;max-height:100%;';

        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'max-width:100%;max-height:calc(100vh - 120px);object-fit:contain;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.15);';
        img.alt = '';
        img.onload = () => {
            const info = document.createElement('div');
            info.style.cssText = 'font-size:0.75rem;color:#999;';
            info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
            wrapper.appendChild(info);
        };

        wrapper.appendChild(img);
        container.appendChild(wrapper);
    }

    private renderVideo(container: HTMLElement, src: string): void {
        const video = document.createElement('video');
        video.src = src;
        video.controls = true;
        video.style.cssText = 'max-width:100%;max-height:calc(100vh - 80px);border-radius:4px;';
        container.appendChild(video);
    }

    private renderAudio(container: HTMLElement, src: string): void {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px;';

        const icon = document.createElement('div');
        icon.textContent = '🎵';
        icon.style.cssText = 'font-size:4rem;';
        wrapper.appendChild(icon);

        const audio = document.createElement('audio');
        audio.src = src;
        audio.controls = true;
        audio.style.cssText = 'width:320px;';
        wrapper.appendChild(audio);

        container.appendChild(wrapper);
    }

    private renderPdf(container: HTMLElement, src: string): void {
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.style.cssText = 'width:100%;height:100%;min-height:600px;border:none;';
        container.appendChild(iframe);
    }

    // ── IEditor interface (read-only stubs) ─────────────────────────────────────

    getText(): string { return ''; }
    setText(_text: string): void { /* binary files are not editable */ }
    isDirty(): boolean { return false; }
    setDirty(_dirty: boolean): void {}
    setReadOnly(_readOnly: boolean): void {}
    focus(): void {}
    setTitle(_title: string): void {}
    getMode(): 'edit' | 'render' { return 'render'; }
    async switchToMode(_mode: 'edit' | 'render'): Promise<void> {}
    get commands() { return {}; }
    async getHeadings(): Promise<Heading[]> { return []; }
    async getSearchableText(): Promise<string> { return ''; }
    async getSummary(): Promise<string | null> { return null; }
    async navigateTo(): Promise<void> {}
    async search(): Promise<UnifiedSearchResult[]> { return []; }
    gotoMatch(): void {}
    clearSearch(): void {}
    async collapseBlocks(): Promise<CollapseExpandResult> { return { affectedCount: 0, allCollapsed: true }; }
    async expandBlocks(): Promise<CollapseExpandResult> { return { affectedCount: 0, allCollapsed: false }; }
    async toggleBlocks(): Promise<CollapseExpandResult> { return this.collapseBlocks(); }
    async pruneAssets(): Promise<number | null> { return null; }

    on<E extends EditorEvent>(
        event: E,
        callback: EditorEventCallback<E>,
    ): () => void {
        return this.editorEvents.on(event, payload => callback(payload));
    }

    async destroy(): Promise<void> {
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
        this.editorEvents.clear();
    }
}
