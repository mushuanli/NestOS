import { t } from '@itookit/common';

/** Keep startup progress and failures visible on devices without a console. */
export function createStartupStatus() {
    const panel = document.createElement('section'); panel.className = 'http-startup';
    panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
    const title = document.createElement('h1'), detail = document.createElement('p');
    title.textContent = t('httpApp.starting'); panel.append(title, detail);
    document.body.append(panel);
    return {
        progress(message: string): void { detail.textContent = message; },
        ready(): void { panel.remove(); },
        fail(error: unknown): void {
            panel.setAttribute('role', 'alert'); title.textContent = t('httpApp.startupFailed');
            detail.textContent = error instanceof Error ? error.message : String(error);
            const reload = document.createElement('button'); reload.type = 'button';
            reload.textContent = t('httpApp.reload'); reload.onclick = () => location.reload();
            panel.append(reload);
        },
    };
}
