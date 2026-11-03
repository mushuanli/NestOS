// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {mountApplicationNavigation, revealWorkspaceNavigation} from '../src/navigation/window-navigation';

afterEach(() => {document.body.replaceChildren();});
it('transfers the real navigation lease and ignores an obsolete release', () => {
    const navigation = document.createElement('nav'), first = document.createElement('footer'), second = document.createElement('footer');
    navigation.className = 'app-sidebar'; document.body.append(navigation, first, second);
    const releaseFirst = mountApplicationNavigation(first, vi.fn())!, releaseSecond = mountApplicationNavigation(second, vi.fn())!;
    releaseFirst(); expect(second.firstElementChild).toBe(navigation); expect(first.children).toHaveLength(0);
    releaseSecond(); releaseSecond(); expect(document.body.firstElementChild).toBe(navigation);
    expect(document.querySelectorAll('.app-sidebar')).toHaveLength(1);
});
it('leaves a host without program navigation untouched', () => {
    const footer = document.createElement('footer'); document.body.append(footer);
    expect(mountApplicationNavigation(footer, vi.fn())).toBeUndefined(); expect(footer.childNodes).toHaveLength(0);
});
it('reveals the current sidebar without touching editors and reports a missing sidebar explicitly', () => {
    const layout = document.createElement('div'), sidebar = document.createElement('aside'), editor = document.createElement('section');
    layout.className = 'mm-layout'; sidebar.className = 'mm-sidebar is-collapsed'; sidebar.hidden = true; sidebar.inert = true;
    layout.dataset.mobileView = 'detail'; layout.dataset.workspaceOpening = 'true'; layout.append(sidebar, editor); document.body.append(layout);
    const draft = document.createElement('textarea'); draft.value = 'Unsaved'; editor.append(draft);
    revealWorkspaceNavigation(editor);
    expect(layout.dataset.mobileView).toBe('list'); expect(layout.dataset.workspaceOpening).toBeUndefined();
    expect(sidebar.hidden).toBe(false); expect(sidebar.inert).toBe(false); expect(sidebar.classList.contains('is-collapsed')).toBe(false);
    expect(editor.firstElementChild).toBe(draft); expect(draft.value).toBe('Unsaved');
    expect(() => revealWorkspaceNavigation(document.createElement('div'))).toThrow(expect.objectContaining({code: 'WORKSPACE_NAVIGATION_UNAVAILABLE'}));
});
