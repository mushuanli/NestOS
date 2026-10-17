import { ACTION_ICONS, t } from '@itookit/common';
import { VFS_DOM_EVENTS } from '@itookit/vfs-ui';

function hasEditorContent(editor: HTMLElement): boolean {
    if (editor.classList.contains('workbench-tabs') && editor.dataset.workbenchView)
        return editor.dataset.workbenchView !== 'empty';
    const containers = editor.classList.contains('workbench-tabs')
        ? [...editor.querySelectorAll<HTMLElement>('.workbench-tabs__panel:not([hidden])')]
        : [editor];
    return containers.some(container => [...container.children].some(child =>
        !child.hasAttribute('hidden') && !child.classList.contains('mm-placeholder') && !child.classList.contains('editor-placeholder')));
}

/** Keep list and editor as separate mobile screens within one workspace. */
export function setupMobileWorkspaceView(layout: HTMLElement, sidebar: HTMLElement, editor: HTMLElement, initialDetail = false): () => void {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mm-mobile-back';
    back.innerHTML = ACTION_ICONS.back;
    back.title = t('workspace.mobile.backToList');
    back.setAttribute('aria-label', t('workspace.mobile.backToList'));
    layout.appendChild(back);
    layout.dataset.mobileView = initialDetail ? 'detail' : 'list';
    let hadContent = false;
    let activation = editor.dataset.workbenchActivation;
    const sync = () => {
        const hasContent = hasEditorContent(editor);
        const active = editor.classList.contains('workbench-tabs')
            ? editor.querySelector('.workbench-tabs__panel:not([hidden])') : editor;
        layout.dataset.mobileHeader = active?.matches('[data-editor-mobile-navigation="embedded"]')
            || active?.querySelector('[data-editor-mobile-navigation="embedded"]') ? 'embedded' : 'standalone';
        if (hasContent !== hadContent || activation !== editor.dataset.workbenchActivation)
            layout.dataset.mobileView = hasContent ? 'detail' : 'list';
        hadContent = hasContent;
        activation = editor.dataset.workbenchActivation;
    };
    const observer = new MutationObserver(sync);
    observer.observe(editor, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-editor-mobile-navigation', 'data-workbench-view', 'data-workbench-activation'] });
    const showList = () => {
        layout.dataset.mobileView = 'list';
    };
    const showDetail = () => { layout.dataset.mobileView = 'detail'; };
    back.addEventListener('click', showList);
    sidebar.addEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail);
    sync();
    return () => { observer.disconnect(); back.remove(); sidebar.removeEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail); };
}
