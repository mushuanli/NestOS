import {createModuleLogger, randomUUID, t} from '@itookit/common';
import type {AttachmentRef, ChatView, DraftAttachment, MessageAction} from '@itookit/llm-ui';
import type {OcrControls} from '@itookit/ui-common';
import {OcrReviewPanel} from '../components/input/OcrReviewPanel';
import {downscaleImageForOcr} from '../utils/imageDownscale';

/** OCR review belongs to the host; text and attachment changes use the shared composer identities. */
export class SharedChatOcr {
    private panel?: OcrReviewPanel;
    private operation?: AbortController;
    private active = true;
    private closed = false;
    constructor(private readonly controls: OcrControls, private readonly view: () => ChatView | undefined,
        private readonly read: (ref: AttachmentRef, signal: AbortSignal) => Promise<Blob>, private readonly error: (error: unknown) => void) {}
    actions(item: DraftAttachment): MessageAction[] {
        if (!item.file.mimeType?.startsWith('image/')) return [];
        return [{id: 'ocr', label: t('chatInput.ocr'), run: () => this.recognize(item).catch(this.error)}];
    }
    private current(item: DraftAttachment): ChatView {
        const view = this.view();
        if (this.closed || !this.active || !view || !view.getDraft().attachments.some(current => current.id === item.id
            && current.file.id === item.file.id && (current.revision ?? 0) === (item.revision ?? 0)))
            throw Object.assign(new Error(t('image.conflict')), {code: 'OCR_ATTACHMENT_CHANGED'});
        return view;
    }
    private async recognize(item: DraftAttachment): Promise<void> {
        const view = this.current(item); this.operation?.abort(); const operation = this.operation = new AbortController();
        const panel = this.panel ??= new OcrReviewPanel(view.inputContext().container);
        const operationId = randomUUID(), started = Date.now(); let stage = 'asset-read';
        panel.showProcessing(item.file.name, () => this.cancel());
        try {
            const image = await this.read(item.file, operation.signal); operation.signal.throwIfAborted(); stage = 'preprocess';
            const prepared = await downscaleImageForOcr(image); operation.signal.throwIfAborted(); stage = 'recognize';
            const text = (await this.controls.recognize(prepared, operation.signal)).trim(); operation.signal.throwIfAborted(); this.current(item);
            if (!text) throw Object.assign(new Error(t('chatInput.ocr.empty')), {code: 'OCR_EMPTY'});
            panel.showReview(image, text, {onConfirm: value => this.apply(item, value, true), onConfirmKeep: value => this.apply(item, value, false),
                onRetry: () => {void this.recognize(item).catch(this.error);}, onCancel: () => this.cancel()});
            report(operationId, stage, started);
        } catch (failure) {
            if (operation.signal.aborted || this.closed) return;
            report(operationId, stage, started, failure);
            panel.showError(failure instanceof Error ? failure.message : String(failure), () => {void this.recognize(item).catch(this.error);}, () => this.cancel()); this.error(failure);
        }
    }
    private apply(item: DraftAttachment, text: string, remove: boolean): void {
        try {
            const view = this.current(item);
            if (remove && !view.removeAttachment({id: item.id, fileId: item.file.id, revision: item.revision ?? 0})) throw new Error(t('image.conflict'));
            view.inputContext().insertAtCursor(text); this.cancel(); view.focus();
        } catch (failure) {this.error(failure);}
    }
    private cancel(): void {this.operation?.abort(); this.panel?.hide();}
    assertRecoverable(): void {if (this.panel?.visible) throw Object.assign(new Error('Finish OCR review before replacing this view'), {code: 'RECOVERY_BUSY'});}
    setActive(active: boolean): void {this.active = active; if (!active) this.cancel();}
    destroy(): void {if (this.closed) return; this.closed = true; this.cancel(); this.panel?.destroy();}
}
function report(operationId: string, stage: string, started: number, failure?: unknown): void {
    const raw = (failure as {code?: unknown})?.code;
    const details = {operationId, stage, result: failure ? 'failure' : 'success', durationMs: Date.now() - started,
        code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : failure ? 'OCR_FAILED' : undefined};
    const log = createModuleLogger('shared-chat-ocr'); if (failure) log.warn('chat.ocr', details); else log.info('chat.ocr', details);
}
