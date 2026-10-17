import { t } from '@itookit/common';

/** Loading and retry feedback belongs to the workspace, leaving global navigation available. */
export function workspaceStatus(container: HTMLElement | null, error?: unknown, retry?: () => void): () => void {
    if (!container) return () => {};
    container.querySelectorAll(':scope > .workspace-status').forEach(node => node.remove());
    if (!retry) return () => {};
    const notice = document.createElement('section'); notice.className = 'workspace-status';
    notice.setAttribute('role', 'alert');
    const title = document.createElement('p');
    title.textContent = t('application.workspaceFailed'); notice.append(title);
    if (retry) {
        const detail = document.createElement('p'); detail.textContent = error instanceof Error ? error.message : String(error);
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t('application.retry');
        button.onclick = () => { notice.remove(); retry(); }; notice.append(detail, button);
    }
    container.append(notice);
    return () => notice.remove();
}
