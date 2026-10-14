import { t } from '@itookit/common';
import { Modal, SettingsAutoSave } from '@itookit/ui-common';

interface FormOptions {
    width: string;
    confirmText: string;
    onConfirm(): Promise<void | false>;
    onAutoSave?(save: SettingsAutoSave): void;
    onClose?(): void;
}

/** Preserve the editing DOM while valid configuration changes save automatically. */
export function showConfigurationForm(container: HTMLElement, title: string, content: string, options: FormOptions, inline: boolean): void {
    if (!inline) { showAutoSaveModal(title, content, options); return; }
    const page = document.createElement('section'); page.className = 'settings-page';
    const header = document.createElement('div'); header.className = 'settings-page__header';
    const heading = document.createElement('h2'); heading.className = 'settings-page__title'; heading.textContent = title;
    const actions = document.createElement('div'); actions.className = 'settings-page__actions';
    const body = document.createElement('div'); body.innerHTML = content;
    header.append(heading, actions); page.append(header, body); container.replaceChildren(page);
    const form = body.querySelector('form')!;
    const save = new SettingsAutoSave(form, options.onConfirm, actions);
    options.onAutoSave?.(save);
}

function showAutoSaveModal(title: string, content: string, options: FormOptions): void {
    const modal = new Modal(title, content, { width: options.width, cancelText: t('action.close'), onCancel: options.onClose });
    modal.show();
    const overlay = document.body.lastElementChild as HTMLElement;
    overlay.querySelector('.settings-modal-confirm')?.remove();
    const form = overlay.querySelector('form')!;
    const save = new SettingsAutoSave(form, options.onConfirm, overlay.querySelector<HTMLElement>('.settings-modal__footer')!);
    options.onAutoSave?.(save);
    overlay.addEventListener('click', event => {
        const target = event.target as HTMLElement;
        if (target !== overlay && !target.closest('.settings-modal-close, .settings-modal-cancel')) return;
        event.stopImmediatePropagation();
        void save.dispose().then(closed => { if (closed) modal.hide(); });
    }, true);
}

export function addConfigurationAction(container: HTMLElement, label: string, run: () => void): void {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-btn settings-btn--secondary';
    button.textContent = label; button.onclick = run; container.querySelector('.settings-page__actions')?.append(button);
}

export function addConfigurationEnabled(container: HTMLElement, enabled: boolean): void {
    const label = document.createElement('label'); label.className = 'settings-form__group';
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'enabled'; input.checked = enabled;
    label.append(input, ' ', t('toolbox.enabled')); container.querySelector('form')?.prepend(label);
}
