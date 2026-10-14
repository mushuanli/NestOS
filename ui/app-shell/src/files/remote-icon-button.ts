import { FILE_BROWSER_ICONS, t, type LocaleKey } from '@itookit/common';

/** Icons stay decorative; translated names serve hover and assistive technology. */
export function remoteIconButton(icon: keyof typeof FILE_BROWSER_ICONS, key: LocaleKey): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'remote-directory__icon-button'; button.title = t(key);
    button.setAttribute('aria-label', t(key)); button.innerHTML = FILE_BROWSER_ICONS[icon];
    return button;
}
