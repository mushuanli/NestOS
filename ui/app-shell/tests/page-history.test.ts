// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {backToPreviousPage, rememberPagePresentation, writePageHistory} from '../src/navigation/page-history';
import {installNavigationButtonPresentation} from '@itookit/ui-common';
import {ACTION_ICONS, t} from '@itookit/common';

afterEach(() => {history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllGlobals();});
it('returns through prior resources and keeps the initial deep link within the application', async () => {
    const fallback = vi.fn();
    writePageHistory('chat', '/directory', '#/chat/directory', 'replace', 'list');
    writePageHistory('chat', '/one.md', '#/chat/one', 'push', 'detail');
    writePageHistory('chat', '/two.md', '#/chat/two', 'push', 'detail');
    expect(history.state.mindosPage).toBe(2);
    const back = () => new Promise<void>(resolve => {window.addEventListener('popstate', () => resolve(), {once: true}); backToPreviousPage(fallback);});
    await back(); expect(history.state.resourceId).toBe('/one.md');
    await back(); expect(history.state.resourceId).toBe('/directory'); expect(history.state.mobileView).toBe('list');
    backToPreviousPage(fallback); expect(fallback).toHaveBeenCalledOnce();
    const push = vi.spyOn(history, 'pushState');
    writePageHistory('chat', '/canonical', '#/chat/canonical', 'replace'); expect(push).not.toHaveBeenCalled(); expect(history.state.mindosPage).toBe(0);
});
it('uses a back icon on mobile and a sidebar icon on desktop, releasing responsive listeners', () => {
    const media = Object.assign(new EventTarget(), {matches: true}); vi.stubGlobal('matchMedia', () => media);
    const button = document.createElement('button'), cleanup = installNavigationButtonPresentation(button);
    const icon = document.createElement('div'); icon.innerHTML = ACTION_ICONS.back;
    expect(button.firstElementChild!.isEqualNode(icon.firstElementChild)).toBe(true); expect(button.getAttribute('aria-label')).toBe(t('workspace.mobile.back'));
    media.matches = false; media.dispatchEvent(new Event('change')); icon.innerHTML = ACTION_ICONS.sidebar;
    expect(button.firstElementChild!.isEqualNode(icon.firstElementChild)).toBe(true); expect(button.title).toBe(t('workspace.sidebar.toggle'));
    cleanup(); media.matches = true; media.dispatchEvent(new Event('change')); expect(button.title).toBe(t('workspace.sidebar.toggle'));
});

it('remembers the sidebar page before a file changes its project scope', async () => {
    writePageHistory('chat', null, '#/chat', 'replace', 'list');
    rememberPagePresentation({mobileView: 'list', navigationScope: '/'});
    writePageHistory('chat', '/folder:personal/@files/note.md', '#/chat/note', 'push', 'detail');
    const back = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), {once: true}));
    backToPreviousPage(() => {throw new Error('Unexpected fallback');}); await back;
    expect(history.state).toMatchObject({resourceId: null, mobileView: 'list', navigationScope: '/'});
    expect(location.hash).toBe('#/chat');
    const forward = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), {once: true}));
    history.forward(); await forward;
    expect(history.state).toMatchObject({resourceId: '/folder:personal/@files/note.md', mobileView: 'detail'});
});
