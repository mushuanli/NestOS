// @file ui-common/components/UIComponents.ts

//import '../styles.css'; // 假设样式文件位置
import { escapeHTML } from '@itookit/common';
export interface ModalOptions {
    confirmText?: string;
    cancelText?: string;
    type?: 'default' | 'danger' | 'success';
    // ✅ [新增] 支持自定义宽度 (例如 '800px' 或 '60vw')
    width?: string; 
    onConfirm?: (element: HTMLElement) => void | boolean | Promise<void | boolean>;
    onCancel?: () => void;
}

export class Modal {
    private element: HTMLElement | null = null;

    constructor(
        private title: string,
        private contentHTML: string,
        private options: ModalOptions = {}
    ) {
        this.options = {
            confirmText: '确认',
            cancelText: '取消',
            type: 'default',
            // 默认为空，使用 CSS 中的默认宽度
            width: '', 
            ...options
        };
    }

    show() {
        const modal = document.createElement('div');
        modal.className = 'settings-modal-overlay';
        
        // ✅ [新增] 处理宽度样式
        // 如果传入了 width，则设置 width，同时设置 max-width 避免在小屏幕溢出
        const styleAttr = this.options.width 
            ? `style="width: ${this.options.width}; max-width: 95vw;"` 
            : '';

        modal.innerHTML = `
            <div class="settings-modal" ${styleAttr}>
                <div class="settings-modal__header">
                    <h3>${this.title}</h3>
                    <button class="settings-modal-close" aria-label="Close">&times;</button>
                </div>
                <div class="settings-modal__body">${this.contentHTML}</div>
                <div class="settings-modal__footer">
                    <button class="settings-btn settings-btn--secondary settings-modal-cancel">${this.options.cancelText}</button>
                    <button class="settings-btn ${this.options.type === 'danger' ? 'settings-btn--danger' : 'settings-btn--primary'} settings-modal-confirm">${this.options.confirmText}</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        this.element = modal;

        const close = () => this.hide();
        
        modal.querySelector('.settings-modal-close')?.addEventListener('click', close);
        modal.querySelector('.settings-modal-cancel')?.addEventListener('click', close);
        const confirm = modal.querySelector<HTMLButtonElement>('.settings-modal-confirm')!;
        confirm.addEventListener('click', async () => {
            if (confirm.disabled) return;
            confirm.disabled = true;
            try {
                const result = await this.options.onConfirm?.(modal);
                if (result !== false) this.hide();
            } catch (error) {
                Toast.error(error instanceof Error ? error.message : String(error));
            } finally { confirm.disabled = false; }
        });
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });

        requestAnimationFrame(() => modal.classList.add('show'));
    }

    hide() {
        if (!this.element) return;
        this.element.classList.remove('show');
        setTimeout(() => {
            this.element?.remove();
            this.options.onCancel?.();
        }, 300);
    }

    static confirm(title: string, message: string, onConfirm: () => void) {
        new Modal(title, `<p>${message}</p>`, {
            type: 'danger',
            confirmText: '确认',
            onConfirm
        }).show();
    }
}

export class Toast {
    static show(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `settings-toast settings-toast--${type}`;
        
        const icons = {
            success: '<i class="fas fa-check-circle"></i>',
            error: '<i class="fas fa-times-circle"></i>',
            warning: '<i class="fas fa-exclamation-triangle"></i>',
            info: '<i class="fas fa-info-circle"></i>'
        };

        toast.innerHTML = `
            <span class="settings-toast__icon">${icons[type]}</span>
            <span class="settings-toast__message">${message}</span>
        `;

        let container = document.querySelector('.settings-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'settings-toast-container';
            document.body.appendChild(container);
        }
        
        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    static success(msg: string) { this.show(msg, 'success'); }
    static error(msg: string) { this.show(msg, 'error'); }
    static warning(msg: string) { this.show(msg, 'warning'); }
    static info(msg: string) { this.show(msg, 'info'); }

    /**
     * 带操作按钮的 Toast（持续 8 秒，点击按钮后立即关闭）。
     *
     * 用于"后台会话有 TTY 活动"等需要用户响应的通知。
     */
    static action(message: string, actionLabel: string, onAction: () => void, duration = 8000): void {
        const toast = document.createElement('div');
        toast.className = 'settings-toast settings-toast--info settings-toast--action';

        toast.innerHTML = `
            <span class="settings-toast__icon"><i class="fas fa-terminal"></i></span>
            <span class="settings-toast__message">${message}</span>
            <button class="settings-toast__action" type="button">${actionLabel}</button>
        `;

        let container = document.querySelector('.settings-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'settings-toast-container';
            document.body.appendChild(container);
        }

        const dismiss = () => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        };

        toast.querySelector('.settings-toast__action')?.addEventListener('click', () => {
            onAction();
            dismiss();
        });

        container.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(dismiss, duration);
    }
}


/**
 * 包装 common Modal 为 Promise 形式
 */
export async function showConfirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
        let resolved = false;
        
        new Modal('Confirmation', `<p>${escapeHTML(message)}</p>`, {
            type: 'danger',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            onConfirm: () => {
                if (!resolved) {
                    resolved = true;
                    resolve(true);
                }
                return true;
            },
            onCancel: () => {
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
                return true;
            }
        }).show();
    });
}
