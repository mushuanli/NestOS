import {ACTION_ICONS, t} from '@itookit/common';
import {requestAssistantShortcut, type ShortcutRequest} from './assistant-actions';

/** Top-level destinations share the same add dialog as resource context menus. */
export function installAssistantNav(signal: AbortSignal, workspace: (elementId: string) => string): () => void {
    const menu = document.createElement('dialog'); menu.className = 'assistant-nav-menu';
    const title = document.createElement('p'), add = document.createElement('button'), close = document.createElement('button');
    add.type = close.type = 'button'; add.textContent = t('assistant.addToShortcuts'); close.textContent = t('action.cancel');
    menu.setAttribute('aria-label', t('assistant.addToShortcuts')); menu.append(title, add, close);
    let selected: ShortcutRequest | undefined, origin: HTMLElement | undefined;
    add.addEventListener('click', () => {menu.close(); if (selected) requestAssistantShortcut(selected);}, {signal});
    close.addEventListener('click', () => menu.close(), {signal});
    menu.addEventListener('click', event => {if (event.target === menu) menu.close();}, {signal});
    menu.addEventListener('close', () => origin?.focus(), {signal});
    const releases: Array<() => void> = [];
    document.querySelectorAll<HTMLElement>('.app-nav-btn[data-target]').forEach(nav => {
        const item = () => ({title: nav.textContent?.trim() || nav.title || nav.dataset.target!,
            target: {kind: 'resource' as const, workspace: workspace(nav.dataset.target!), resource: ''}});
        const show = (event: Event) => {event.preventDefault(); event.stopPropagation(); origin = nav; selected = item(); title.textContent = selected.title; if (!menu.isConnected) document.body.append(menu); menu.showModal();};
        nav.addEventListener('contextmenu', show, {signal});
        nav.addEventListener('keydown', event => {if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') show(event);}, {signal});
        if (nav.closest('#mobile-more-menu')) {
            const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'assistant-nav-pin';
            pin.innerHTML = ACTION_ICONS.favorite; const caption = document.createElement('span'); caption.textContent = t('assistant.addToShortcuts'); pin.append(caption); pin.title = `${t('assistant.addToShortcuts')} · ${item().title}`; pin.setAttribute('aria-label', pin.title);
            pin.addEventListener('click', event => {event.preventDefault(); event.stopPropagation(); nav.closest<HTMLDialogElement>('dialog')?.close(); requestAssistantShortcut(item());}, {signal});
            const row = document.createElement('div'); row.className = 'assistant-nav-item'; nav.replaceWith(row); row.append(nav, pin); releases.push(() => row.replaceWith(nav));
        }
    });
    return () => {menu.remove(); releases.forEach(release => release());};
}
