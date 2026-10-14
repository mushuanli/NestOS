// @file: llm-ui/components/input/OcrReviewPanel.ts
//
// OCR 审阅面板 — 图片转文字的处理 / 审阅 / 错误三态。
//
// 挂载方式与 ChatInputView.showToolOutput 一致:懒建一个 div,
// 插入到 .llm-input__field-wrapper 之前(执行器选择行与输入框之间)。
//
// 三态:
//   processing — ⏳ 识别中(可取消)
//   review     — 左图右文(textarea 可编辑)+ 确认/保留/重试/取消
//   error      — 失败提示 + 重试/取消
//
// 文案走 t(),图标走 ACTION_ICONS / FEEDBACK_ICONS。组件不感知 OCR 业务,
// 仅通过回调把用户编辑后的文本回传给 ChatInput。

import { t, escapeHTML, ACTION_ICONS, FEEDBACK_ICONS } from '@itookit/common';

export interface OcrReviewCallbacks {
    /** 确认:插入(编辑后的)文本并移除原图 */
    onConfirm: (text: string) => void;
    /** 确认:插入文本但保留原图 */
    onConfirmKeep: (text: string) => void;
    /** 重试识别 */
    onRetry: () => void;
    /** 取消,丢弃结果 */
    onCancel: () => void;
}

export class OcrReviewPanel {
    private el: HTMLElement | null = null;
    /** review 态下用户可编辑的结果框 */
    private textarea: HTMLTextAreaElement | null = null;
    /** review 态下创建的 object URL,需在 hide/destroy 时回收 */
    private objectUrl: string | null = null;

    constructor(private readonly container: HTMLElement) {}

    // ── State: processing ────────────────────────────────────────────────────

    /** 显示「识别中」态。onCancel 允许用户中止等待。 */
    showProcessing(filename: string, onCancel: () => void): void {
        const el = this.ensureEl();
        this.releaseObjectUrl();
        el.innerHTML = `
            <div class="llm-input__ocr-header">
                <span class="llm-input__ocr-title">
                    ${ACTION_ICONS.ocr} ${escapeHTML(filename)}
                </span>
                <button class="llm-input__ocr-close" type="button" title="${t('chatInput.ocr.cancel')}">×</button>
            </div>
            <div class="llm-input__ocr-status">
                ${FEEDBACK_ICONS.loading} ${t('chatInput.ocr.processing')}
            </div>`;
        el.style.display = 'block';
        this.textarea = null;
        el.querySelector('.llm-input__ocr-close')
            ?.addEventListener('click', () => onCancel());
        el.scrollIntoView?.({ block: 'nearest' });
    }

    // ── State: review ────────────────────────────────────────────────────────

    /**
     * 显示审阅态:左侧源图缩略图,右侧可编辑结果。
     * @param imageBlob 源图(用于生成缩略图预览)
     * @param text      OCR 识别出的 markdown(预填到 textarea,可编辑)
     */
    showReview(imageBlob: Blob, text: string, cb: OcrReviewCallbacks): void {
        const el = this.ensureEl();
        this.releaseObjectUrl();
        this.objectUrl = URL.createObjectURL(imageBlob);

        el.innerHTML = `
            <div class="llm-input__ocr-header">
                <span class="llm-input__ocr-title">
                    ${ACTION_ICONS.ocr} ${t('chatInput.ocr.review.title')}
                </span>
                <button class="llm-input__ocr-close" type="button" title="${t('chatInput.ocr.cancel')}">×</button>
            </div>
            <div class="llm-input__ocr-review">
                <img class="llm-input__ocr-thumb" src="${this.objectUrl}" alt="source" />
                <textarea class="llm-input__ocr-text" spellcheck="false"></textarea>
            </div>
            <div class="llm-input__ocr-actions">
                <button class="llm-input__ocr-btn-confirm" type="button">${t('chatInput.ocr.review.confirm')}</button>
                <button class="llm-input__ocr-btn-keep" type="button">${t('chatInput.ocr.review.confirmKeep')}</button>
                <button class="llm-input__ocr-btn-retry" type="button">${t('chatInput.ocr.retry')}</button>
                <button class="llm-input__ocr-btn-cancel" type="button">${t('chatInput.ocr.cancel')}</button>
            </div>`;
        el.style.display = 'block';

        this.textarea = el.querySelector('.llm-input__ocr-text');
        if (this.textarea) this.textarea.value = text;

        const current = () => this.textarea?.value ?? text;
        el.querySelector('.llm-input__ocr-btn-confirm')
            ?.addEventListener('click', () => cb.onConfirm(current()));
        el.querySelector('.llm-input__ocr-btn-keep')
            ?.addEventListener('click', () => cb.onConfirmKeep(current()));
        el.querySelector('.llm-input__ocr-btn-retry')
            ?.addEventListener('click', () => cb.onRetry());
        el.querySelector('.llm-input__ocr-btn-cancel')
            ?.addEventListener('click', () => cb.onCancel());
        el.querySelector('.llm-input__ocr-close')
            ?.addEventListener('click', () => cb.onCancel());

        el.scrollIntoView?.({ block: 'nearest' });
        this.textarea?.focus();
    }

    // ── State: error ─────────────────────────────────────────────────────────

    showError(message: string, onRetry: () => void, onCancel: () => void): void {
        const el = this.ensureEl();
        this.releaseObjectUrl();
        el.innerHTML = `
            <div class="llm-input__ocr-header">
                <span class="llm-input__ocr-title">
                    ${FEEDBACK_ICONS.error} ${t('chatInput.ocr.failed')}
                </span>
                <button class="llm-input__ocr-close" type="button" title="${t('chatInput.ocr.cancel')}">×</button>
            </div>
            <div class="llm-input__ocr-status llm-input__ocr-status--error">${escapeHTML(message)}</div>
            <div class="llm-input__ocr-actions">
                <button class="llm-input__ocr-btn-retry" type="button">${t('chatInput.ocr.retry')}</button>
                <button class="llm-input__ocr-btn-cancel" type="button">${t('chatInput.ocr.cancel')}</button>
            </div>`;
        el.style.display = 'block';
        this.textarea = null;
        el.querySelector('.llm-input__ocr-btn-retry')?.addEventListener('click', () => onRetry());
        el.querySelector('.llm-input__ocr-btn-cancel')?.addEventListener('click', () => onCancel());
        el.querySelector('.llm-input__ocr-close')?.addEventListener('click', () => onCancel());
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    hide(): void {
        this.releaseObjectUrl();
        this.textarea = null;
        if (this.el) {
            this.el.style.display = 'none';
            this.el.innerHTML = '';
        }
    }

    destroy(): void {
        this.releaseObjectUrl();
        this.textarea = null;
        this.el?.remove();
        this.el = null;
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /** 懒建面板元素并插入到 .llm-input__field-wrapper 之前。 */
    private ensureEl(): HTMLElement {
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.className = 'llm-input__ocr-panel';
            const wrapper = this.container.querySelector('.llm-input__field-wrapper');
            const parent = wrapper?.parentElement ?? this.container;
            parent.insertBefore(this.el, wrapper ?? parent.firstChild);
        }
        return this.el;
    }

    private releaseObjectUrl(): void {
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
    }
}


