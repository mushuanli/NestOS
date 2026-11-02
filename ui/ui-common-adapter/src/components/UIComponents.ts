import {Modal as BaseModal, showConfirmDialog as confirm} from '@itookit/ui-common';
import type {ModalOptions} from '@itookit/ui-common';
import {t} from '@itookit/common';
export {Toast} from '@itookit/ui-common';
export type {ModalOptions} from '@itookit/ui-common';

/** NestOS contributes labels; the independent foundation owns dialog behavior. */
export class Modal extends BaseModal {
    constructor(title: string, content: string, options: ModalOptions = {}) {
        super(title, content, {confirmText: t('action.confirm'), cancelText: t('action.cancel'), closeLabel: t('action.close'), ...options});
    }
    static confirm(title: string, message: string, onConfirm: () => void): void {
        void confirm(message, {title, confirmText: t('action.confirm'), cancelText: t('action.cancel'), closeLabel: t('action.close')}).then(accepted => {if (accepted) onConfirm();});
    }
}
export function showConfirmDialog(message: string): Promise<boolean> {
    return confirm(message, {confirmText: t('action.confirm'), cancelText: t('action.cancel'), closeLabel: t('action.close')});
}
