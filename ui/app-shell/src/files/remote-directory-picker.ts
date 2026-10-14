import { remoteIconButton } from './remote-icon-button';
import { remoteConnectionError } from './remote-connection-error';
import { t } from '@itookit/common';
import type { ProjectService } from '@itookit/app-contracts/services';

/** Browse one page at a time; a new navigation supersedes every older response. */
export function remoteDirectoryPicker(projects: ProjectService, parent: HTMLElement,
    connection: HTMLSelectElement, path: HTMLInputElement, signal: AbortSignal) {
    const panel = document.createElement('div'); panel.className = 'remote-directory';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const list = document.createElement('div'); list.className = 'remote-directory__list';
    const actions = document.createElement('div'); actions.className = 'remote-directory__actions';
    panel.append(actions, status, list); parent.append(panel);
    let pending: AbortController | undefined;
    const button = (parent: HTMLElement, label: string, run: () => void) => {
        const item = document.createElement('button'); item.type = 'button'; item.textContent = label;
        item.onclick = run; parent.append(item); return item;
    };
    const load = async (directory: string, cursor?: string, cached?: { paths: string[]; nextCursor: string | null }) => {
        pending?.abort(); const current = pending = new AbortController();
        const requestSignal = AbortSignal.any([signal, current.signal]);
        if (!connection.value || requestSignal.aborted) return;
        const target = directory.replace(/\/+$/, '') || '/';
        status.textContent = t('remote.directoryLoading'); path.setCustomValidity(status.textContent); list.replaceChildren();
        try {
            const page = cached ?? await projects.remoteMounts!.browseDirectories(connection.value, target, cursor, { signal: requestSignal, timeoutMs: 5000 });
            if (requestSignal.aborted) return;
            path.setCustomValidity('');
            status.textContent = page.paths.length ? target : t('remote.directoryEmpty');
            for (const child of page.paths) button(list, child, () => { path.value = child; void load(child); });
            if (page.nextCursor) button(list, t('remote.directoryMore'), () => { void load(target, page.nextCursor!); });
        } catch (error) { if (!requestSignal.aborted) { status.textContent = remoteConnectionError(error); path.setCustomValidity(status.textContent); } }
    };
    const root = remoteIconButton('root', 'remote.directoryRoot'); root.onclick = () => { void load('/'); };
    const up = remoteIconButton('up', 'remote.directoryUp'); up.onclick = () => { path.value = path.value.replace(/\/[^/]+\/?$/, '') || '/'; void load(path.value); };
    const browse = remoteIconButton('browse', 'remote.directoryBrowse'); browse.onclick = () => { void load(path.value || '/'); };
    actions.append(root, up, browse);
    path.addEventListener('input', () => { pending?.abort(); list.replaceChildren(); status.textContent = ''; });
    return {
        reset: (page?: { paths: string[]; nextCursor: string | null }) => { path.value = ''; void load('/', undefined, page); },
        clear: () => { pending?.abort(); path.value = ''; path.setCustomValidity(''); list.replaceChildren(); status.textContent = ''; },
        cancel: () => { pending?.abort(); path.setCustomValidity(''); },
    };
}
