import { t } from '@itookit/common';
import type { WorkspaceConfig } from '../types';

export const START_PAGE_ID = 'app-start-page';
export const START_PAGE_SLUG = 'start';

/** Offer navigation without inspecting recent resources or starting workspace modules. */
export function installStartPage(workspaces: WorkspaceConfig[], signal: AbortSignal, navigate: (id: string) => void): () => void {
    const page = document.createElement('section'); page.id = START_PAGE_ID; page.className = 'workspace-view app-start';
    const title = document.createElement('h1'), help = document.createElement('p'), choices = document.createElement('nav');
    title.textContent = t('application.startTitle'); help.textContent = t('application.startHelp');
    choices.className = 'app-start__choices'; choices.setAttribute('aria-label', title.textContent);
    document.querySelectorAll<HTMLElement>('.app-sidebar .app-nav-btn[data-target]').forEach(nav => {
        const workspace = workspaces.find(ws => ws.elementId === nav.dataset.target);
        if (!workspace) return;
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'app-start__choice';
        choice.textContent = nav.querySelector('span')?.textContent ?? workspace.title ?? workspace.slug;
        choice.addEventListener('click', () => navigate(workspace.elementId), { signal }); choices.append(choice);
    });
    page.append(title, help, choices); (document.querySelector('.main-content-area') ?? document.body).append(page);
    return () => page.remove();
}
