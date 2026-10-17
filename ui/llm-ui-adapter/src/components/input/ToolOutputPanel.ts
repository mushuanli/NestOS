// @file: llm-ui/components/input/ToolOutputPanel.ts
// 内联工具输出面板：展示 /read /grep /glob、`!` 与 /exec 等直接调用的结果。
// 从 ChatInputView 抽出，自包含（创建/渲染/清除），不持有 ChatInput 状态。

import { FEEDBACK_ICONS, t } from '@itookit/common';

const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class ToolOutputPanel {
    private el: HTMLElement | null = null;

    constructor(
        private readonly container: HTMLElement,
        private readonly refocus: () => void,
    ) {}

    /** 显示工具执行结果；空输出时不渲染 body。 */
    show(cmd: string, output: string, success: boolean): void {
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.className = 'llm-input__tool-output';
            // Insert above the field wrapper so it sits between executor selector and textarea.
            const wrapper = this.container.querySelector('.llm-input__field-wrapper');
            const parent = wrapper?.parentElement ?? this.container;
            parent.insertBefore(this.el, wrapper ?? parent.firstChild);
        }

        const icon = success ? FEEDBACK_ICONS.success : FEEDBACK_ICONS.error;
        const status = t(success ? 'chatInput.toolOutput.done' : 'chatInput.toolOutput.failed');

        this.el.innerHTML = `
            <div class="llm-input__tool-output-header">
                <code class="llm-input__tool-output-cmd">$ ${escapeHtml(cmd)}</code>
                <span class="llm-input__tool-output-meta">${icon} ${escapeHtml(status)}</span>
                <button class="llm-input__tool-output-close" type="button" title="${escapeHtml(t('action.close'))}">×</button>
            </div>
            <pre class="llm-input__tool-output-body">${escapeHtml(output)}</pre>`;

        this.el.style.display = 'block';
        this.el.querySelector('.llm-input__tool-output-close')?.addEventListener('click', () => this.clear());

        this.el.scrollIntoView?.({ block: 'nearest' });
        this.refocus();
    }

    /** 隐藏并清空面板内容。 */
    clear(): void {
        if (this.el) {
            this.el.style.display = 'none';
            this.el.innerHTML = '';
        }
    }
}
