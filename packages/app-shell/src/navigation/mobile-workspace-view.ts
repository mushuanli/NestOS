import { t } from '@itookit/common';
import { VFS_DOM_EVENTS } from '@itookit/vfs-ui';

function hasEditorContent(editor: HTMLElement): boolean {
    const containers = editor.classList.contains('workbench-tabs')
        ? [...editor.querySelectorAll<HTMLElement>('.workbench-tabs__panel:not([hidden])')]
        : [editor];
    return containers.some(container => [...container.children].some(child =>
        !child.hasAttribute('hidden') && !child.classList.contains('mm-placeholder') && !child.classList.contains('editor-placeholder')));
}

/** Keep list and editor as separate mobile screens within one workspace. */
export function setupMobileWorkspaceView(layout: HTMLElement, sidebar: HTMLElement, editor: HTMLElement): () => void {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mm-mobile-back';
    back.textContent = `← ${t('workspace.mobile.backToList')}`;
    back.setAttribute('aria-label', t('workspace.mobile.backToList'));
    layout.appendChild(back);
    let hadContent: boolean | undefined;
    const sync = () => {
        const hasContent = hasEditorContent(editor);
        if (hasContent !== hadContent) layout.dataset.mobileView = hasContent ? 'detail' : 'list';
        hadContent = hasContent;
    };
    const observer = new MutationObserver(sync);
    observer.observe(editor, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const showList = () => {
        layout.dataset.mobileView = 'list';
    };
    const showDetail = () => { layout.dataset.mobileView = 'detail'; };
    back.addEventListener('click', showList);
    sidebar.addEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail);
    sync();
    return () => { observer.disconnect(); back.removeEventListener('click', showList); sidebar.removeEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail); };
}
