import { remoteIconButton } from './remote-icon-button';
import { t } from '@itookit/common';
import type { ProjectService } from '@itookit/app-contracts/services';
import { remoteConnectionError } from './remote-connection-error';

type DirectoryPage = { paths: string[]; nextCursor: string | null };

/** Only successfully probed connections are selectable; two workers bound concurrent requests. */
export function remoteConnectionOptions(projects: ProjectService, parent: HTMLElement,
    select: HTMLSelectElement, lifetime: AbortSignal, ready: (page?: DirectoryPage) => void, clear: () => void) {
    const placeholder = new Option(t('remote.selectAvailable'), ''); select.prepend(placeholder); select.value = '';
    const retry = remoteIconButton('refresh', 'remote.recheck');
    const controls = document.createElement('div'); controls.className = 'remote-connection__controls';
    select.replaceWith(controls); controls.append(select, retry);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); parent.append(status);
    let pending: AbortController | undefined;
    const pages = new Map<string, DirectoryPage>();
    const connections = projects.remoteMounts!.connections();
    const options = new Map(Array.from(select.options).map(option => [option.value, option]));
    for (const connection of connections) options.get(connection.id)!.disabled = true;
    select.onchange = () => ready(pages.get(select.value));
    const check = async () => {
        pending?.abort(); pending = new AbortController(); clear(); pages.clear(); select.value = '';
        const signal = AbortSignal.any([lifetime, pending.signal]);
        retry.disabled = true; select.disabled = true; status.textContent = t('remote.state.checking');
        for (const connection of connections) { const option = options.get(connection.id)!; option.disabled = true; option.textContent = `${connection.name} · ${t('remote.state.checking')}`; }
        const queue = [...connections], errors: string[] = [];
        await Promise.all([worker(), worker()]);
        if (signal.aborted) return;
        retry.disabled = false; select.disabled = !pages.size;
        status.textContent = errors.join('\n') || t(connections.length ? 'remote.selectAvailable' : 'remote.connectionEmpty');
        async function worker() {
            while (queue.length && !signal.aborted) {
                const connection = queue.shift()!, option = options.get(connection.id)!;
                try {
                    const page = await projects.remoteMounts!.browseDirectories(connection.id, '/', undefined, { signal, timeoutMs: 5000 });
                    if (signal.aborted) return;
                    pages.set(connection.id, page); option.disabled = false;
                    option.textContent = `${connection.name} · ${t('remote.state.online')}`;
                } catch (error) {
                    if (signal.aborted) return;
                    option.textContent = `${connection.name} · ${t('remote.state.offline')}`;
                    errors.push(`${connection.name}：${remoteConnectionError(error)}`);
                }
            }
        }
    };
    retry.onclick = () => { void check(); };
    return { check: () => { void check(); }, cancel: () => { pending?.abort(); clear(); } };
}
