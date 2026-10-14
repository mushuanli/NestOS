// @file: llm-ui/components/input/AttachmentManager.ts
// File attachment handling: paste, drag-drop, OCR, camera, photo album.

import { ChatInputTemplates } from '../templates/ChatInputTemplates';
import { downscaleImageForOcr } from '../../utils/imageDownscale';
import { t } from '@itookit/common';
import { OcrReviewPanel } from './OcrReviewPanel';
import type { PopupPanel, PopupItem } from './plugins/PopupPanel';

let CAMERA_GUARD = false;      // prevent double-open on some mobile browsers
let PHOTO_ALBUM_GUARD = false;

export interface AttachmentManagerOptions {
    container: HTMLElement;
    fileInput: HTMLInputElement;
    attachmentContainer: HTMLElement;
    textarea: HTMLTextAreaElement;
    inputWrapper: HTMLElement;
    attachBtn: HTMLButtonElement;
    ocr?: import('@itookit/ui-common').OcrControls;
    onRequestFiles?: (query: string) => Promise<any[]>;
    getLoading: () => boolean;
    getFiles: () => File[];
    setFiles: (files: File[]) => void;
    notifyConfigChange: () => void;
}

export class AttachmentManager {
    private ocrPanel: OcrReviewPanel | null = null;
    private addPopup: PopupPanel | null = null;
    private unsubscribe?: () => void;
    private revision = 0;
    private activeOcr?: AbortController;

    constructor(private opts: AttachmentManagerOptions) {
        this.unsubscribe = opts.ocr?.subscribe(() => this.renderAttachments());
    }

    // ── Paste ─────────────────────────────────────────────────────────────

    handlePaste(e: ClipboardEvent): void {
        if (this.opts.getLoading()) return;
        const items = e.clipboardData?.items;
        if (!items) return;

        const pastedFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const file = items[i].getAsFile();
                if (file) pastedFiles.push(this.renameFileIfNeeded(file));
            }
        }
        if (pastedFiles.length > 0) this.addFiles(pastedFiles);
    }

    private renameFileIfNeeded(file: File): File {
        if (file.name === 'image.png' || file.name === 'image.jpg') {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            return new File([file], `paste_${timestamp}.${file.name.split('.').pop()}`, { type: file.type });
        }
        return file;
    }

    addFiles(newFiles: File[]): void {
        this.opts.setFiles([...this.opts.getFiles(), ...newFiles]);
        this.renderAttachments();
    }

    renderAttachments(): void {
        const revision = ++this.revision;
        const files = this.opts.getFiles();
        if (files.length === 0) {
            this.opts.attachmentContainer.replaceChildren();
            this.opts.attachmentContainer.style.display = 'none';
            return;
        }
        this.opts.attachmentContainer.style.display = 'flex';
        const canOcr = !!this.opts.ocr;
        this.opts.attachmentContainer.innerHTML = ChatInputTemplates.renderAttachments(files, canOcr);
        const button = this.opts.attachmentContainer.querySelector<HTMLButtonElement>('[data-ocr-configure]');
        if (button && this.opts.ocr) {
            button.onclick = () => { void this.opts.ocr!.configure().catch(error => { button.title = String(error); }); };
            void this.opts.ocr.label().then(label => {
                if (revision === this.revision) { button.textContent = t('ocr.current', { label }); button.title = t('ocr.configure') + ' · ' + label; }
            }).catch(error => { if (revision === this.revision) button.title = String(error); });
        }
    }

    // ── Drag events ───────────────────────────────────────────────────────

    bindDragEvents(): void {
        const wrapper = this.opts.inputWrapper;

        wrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.opts.getLoading()) {
                wrapper.classList.add('llm-input__field-wrapper--drag-active');
            }
        });

        wrapper.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            wrapper.classList.remove('llm-input__field-wrapper--drag-active');
        });

        wrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            wrapper.classList.remove('llm-input__field-wrapper--drag-active');
            if (this.opts.getLoading()) return;
            const droppedFiles = e.dataTransfer?.files;
            if (droppedFiles && droppedFiles.length > 0) {
                this.addFiles(Array.from(droppedFiles));
            }
        });
    }

    // ── "+" add-source menu ───────────────────────────────────────────────

    toggleAddMenu(createPopup: (anchor: HTMLElement, opts?: any) => PopupPanel): void {
        if (!this.addPopup) {
            this.addPopup = createPopup(this.opts.attachBtn, { animated: true });
        }
        if (this.addPopup.isVisible) { this.addPopup.hide(); return; }

        const items: PopupItem[] = [
            { id: 'camera',     label: t('chatInput.add.camera'),     icon: '📷' },
            { id: 'photoAlbum', label: t('chatInput.add.photoAlbum'), icon: '🖼️' },
            { id: 'attach',     label: t('chatInput.add.attach'),     icon: '📎' },
        ];
        if (this.opts.onRequestFiles) {
            items.push({ id: 'fileRef', label: t('chatInput.add.fileRef'), icon: '@' });
        }

        this.addPopup.show(items, {
            onSelect: (item) => {
                switch (item.id) {
                    case 'camera':
                        this.openCamera();
                        break;
                    case 'photoAlbum':
                        this.openPhotoAlbum();
                        break;
                    case 'attach':
                        this.opts.fileInput.click();
                        break;
                    case 'fileRef':
                        this.insertFileRef();
                        break;
                }
            },
        });
    }

    // ── Camera ────────────────────────────────────────────────────────────

    private openCamera(): void {
        if (CAMERA_GUARD) return;
        CAMERA_GUARD = true;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.setAttribute('capture', 'environment');
        input.style.display = 'none';
        document.body.appendChild(input);

        // Some Android browsers fire both cancel + change; guard clears after both
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            CAMERA_GUARD = false;
            setTimeout(() => input.remove(), 100);
        };

        input.addEventListener('change', () => {
            if (input.files?.length) {
                this.addFiles(Array.from(input.files!));
            }
            done();
        });
        // cancel event is not standard — use window focus as fallback
        input.addEventListener('cancel', done);
        const onFocus = () => { window.removeEventListener('focus', onFocus); done(); };
        window.addEventListener('focus', onFocus);

        input.click();
    }

    // ── Photo Album ───────────────────────────────────────────────────────

    private openPhotoAlbum(): void {
        if (PHOTO_ALBUM_GUARD) return;
        PHOTO_ALBUM_GUARD = true;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);

        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            PHOTO_ALBUM_GUARD = false;
            setTimeout(() => input.remove(), 100);
        };

        input.addEventListener('change', () => {
            if (input.files?.length) {
                this.addFiles(Array.from(input.files!));
            }
            done();
        });
        input.addEventListener('cancel', done);
        const onFocus = () => { window.removeEventListener('focus', onFocus); done(); };
        window.addEventListener('focus', onFocus);

        input.click();
    }

    // ── File reference ────────────────────────────────────────────────────

    private insertFileRef(): void {
        const ta = this.opts.textarea;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const after = ta.value.slice(pos);
        ta.value = before + '@' + after;
        ta.selectionStart = ta.selectionEnd = pos + 1;
        ta.focus();
        this.opts.notifyConfigChange();
    }

    // ── OCR (image → text) ────────────────────────────────────────────────

    /** Process sequentially; preserve completed text and stop on the first failure. */
    async ocrAllImages(): Promise<void> {
        if (!this.opts.ocr) return;
        const files = this.opts.getFiles().filter(file => file.type.startsWith('image/'));
        if (files.length < 2) return;
        const { panel, signal } = this.startOcr(t('chatInput.ocr.all'));
        const results: string[] = [], processed = new Set<File>();
        for (const file of files) {
            if (signal.aborted) return;
            try {
                const text = await this.recognize(file, signal);
                if (signal.aborted) return;
                results.push(text); processed.add(file);
            } catch (error) {
                if (signal.aborted) return;
                this.showOcrError(panel, file, error); break;
            }
            if (processed.size === files.length) panel.hide();
            else panel.showProcessing(t('chatInput.ocr.all.done')
                .replace('{done}', String(processed.size)).replace('{total}', String(files.length)), () => this.cancelOcr());
        }
        if (!results.length || signal.aborted) return;
        this.insertOcrText(results.join('\n\n'));
        this.opts.setFiles(this.opts.getFiles().filter(file => !processed.has(file)));
        this.renderAttachments(); this.opts.notifyConfigChange();
    }

    async ocrImage(file: File, index: number): Promise<void> {
        if (!this.opts.ocr || index < 0) return;
        const { panel, signal } = this.startOcr(file.name);
        try {
            const markdown = await this.recognize(file, signal);
            if (signal.aborted) return;
            panel.showReview(file, markdown, {
                onConfirm: text => this.applyOcrResult(text, file, true),
                onConfirmKeep: text => this.applyOcrResult(text, file, false),
                onRetry: () => { void this.ocrImage(file, this.opts.getFiles().indexOf(file)); },
                onCancel: () => this.cancelOcr(),
            });
        } catch (error) {
            if (!signal.aborted) this.showOcrError(panel, file, error);
        }
    }

    private startOcr(label: string): { panel: OcrReviewPanel; signal: AbortSignal } {
        this.activeOcr?.abort(); this.activeOcr = new AbortController();
        const panel = this.ocrPanel ??= new OcrReviewPanel(this.opts.container);
        panel.showProcessing(label, () => this.cancelOcr());
        return { panel, signal: this.activeOcr.signal };
    }
    private cancelOcr(): void { this.activeOcr?.abort(); this.ocrPanel?.hide(); }
    private async recognize(file: File, signal: AbortSignal): Promise<string> {
        const downscaled = await downscaleImageForOcr(file);
        signal.throwIfAborted();
        const text = (await this.opts.ocr!.recognize(downscaled, signal)).trim();
        if (!text) throw new Error(t('chatInput.ocr.empty'));
        return text;
    }
    private showOcrError(panel: OcrReviewPanel, file: File, error: unknown): void {
        panel.showError(error instanceof Error ? error.message : String(error),
            () => { void this.ocrImage(file, this.opts.getFiles().indexOf(file)); }, () => this.cancelOcr());
    }
    private insertOcrText(text: string): void {
        const ta = this.opts.textarea, pos = ta.selectionStart;
        ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos);
        ta.selectionStart = ta.selectionEnd = pos + text.length; ta.focus();
    }

    private applyOcrResult(text: string, file: File, removeImage: boolean): void {
        this.insertOcrText(text);

        if (removeImage) {
            this.opts.setFiles(this.opts.getFiles().filter(item => item !== file));
            this.renderAttachments();
        }
        this.opts.notifyConfigChange();
        this.ocrPanel?.hide();
    }

    // ── Cleanup ───────────────────────────────────────────────────────────

    destroy(): void {
        this.revision++; this.activeOcr?.abort(); this.unsubscribe?.();
        this.addPopup?.destroy();
        this.addPopup = null;
        this.ocrPanel?.destroy();
        this.ocrPanel = null;
    }
}
