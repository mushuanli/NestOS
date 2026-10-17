// @file: llm-ui/components/input/HelpPanel.ts
// 内嵌帮助面板：展示键盘快捷键 / slash 命令 / @mention 用法 / Agent Mode 命令。
// 从 ChatInputView 抽出，自包含（渲染/显隐/外部点击关闭），不持有 ChatInput 状态。

import { ChatInputTemplates } from '../templates/ChatInputTemplates';

export interface HelpPanelDeps {
    /** 是否注册了文件请求回调（决定帮助里是否展示 @mention 说明）。 */
    hasFiles: () => boolean;
    /** 打开帮助时收起设置面板。 */
    onCloseSettings: () => void;
}

export class HelpPanel {
    private readonly panel: HTMLElement;
    private readonly body: HTMLElement;
    private visible = false;
    private readonly outsideHandler: (e: MouseEvent) => void;

    constructor(
        container: HTMLElement,
        private readonly deps: HelpPanelDeps,
    ) {
        this.panel = container.querySelector('.llm-input__help-panel')!;
        this.body = container.querySelector('.llm-input__help-body')!;

        this.panel.querySelector('.llm-input__help-close')
            ?.addEventListener('click', () => this.hide());

        this.outsideHandler = (e: MouseEvent) => {
            if (this.visible && !this.panel.contains(e.target as Node)) this.hide();
        };
        document.addEventListener('click', this.outsideHandler);
    }

    get isVisible(): boolean { return this.visible; }

    show(): void {
        if (this.visible) return;
        this.body.innerHTML = ChatInputTemplates.renderHelpContent(this.deps.hasFiles());
        this.panel.style.display = 'block';
        this.visible = true;
        this.deps.onCloseSettings();
    }

    hide(): void {
        if (!this.visible) return;
        this.panel.style.display = 'none';
        this.visible = false;
    }

    toggle(): void {
        if (this.visible) this.hide();
        else this.show();
    }

    destroy(): void {
        document.removeEventListener('click', this.outsideHandler);
    }
}
