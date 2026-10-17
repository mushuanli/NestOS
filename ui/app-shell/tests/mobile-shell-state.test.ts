// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {installMobileShellState} from '../src/navigation/mobile-shell-state';

let dispose: (() => void) | undefined;
afterEach(() => {dispose?.(); document.body.replaceChildren(); delete document.body.dataset.mobileNavigation;});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

it('hides navigation only for the active conversation detail and restores it on return to the list', async () => {
    document.body.innerHTML = '<nav class="app-sidebar"></nav><section class="workspace-view active"><div class="mm-layout" data-mobile-view="detail" data-mobile-header="embedded"></div></section><section class="workspace-view"><div class="mm-layout" data-mobile-view="detail" data-mobile-header="embedded"></div></section>';
    dispose = installMobileShellState(); expect(document.body.dataset.mobileNavigation).toBe('immersive');
    const layout = document.querySelector<HTMLElement>('.mm-layout')!;
    layout.dataset.mobileView = 'list'; await flush(); expect(document.body.dataset.mobileNavigation).toBe('standard');
    layout.dataset.mobileView = 'detail'; await flush(); expect(document.body.dataset.mobileNavigation).toBe('immersive');
    layout.dataset.mobileHeader = 'standalone'; await flush(); expect(document.body.dataset.mobileNavigation).toBe('standard');
    document.querySelector('.workspace-view.active')!.remove(); await flush();
    expect(document.body.dataset.mobileNavigation).toBe('standard');
    document.querySelector('.workspace-view')!.classList.add('active'); await flush();
    expect(document.body.dataset.mobileNavigation).toBe('immersive');
});

it('follows focused composing state without reacting to hidden tabs or hidden workspaces', async () => {
    document.body.innerHTML = '<section class="workspace-view active"><div data-editor-composing="true"><textarea></textarea></div></section>';
    dispose = installMobileShellState(); const field = document.querySelector('textarea')!;
    field.focus(); await flush(); expect(document.body.dataset.mobileNavigation).toBe('composing');
    field.parentElement!.hidden = true; await flush(); expect(document.body.dataset.mobileNavigation).toBe('standard');
    field.parentElement!.hidden = false; await flush();
    field.blur(); await flush(); expect(document.body.dataset.mobileNavigation).toBe('standard');
    field.focus(); document.querySelector('.workspace-view')!.classList.remove('active'); await flush();
    expect(document.body.dataset.mobileNavigation).toBe('standard');
});

it('keeps navigation hidden while the requested conversation is being rebound', async () => {
    document.body.innerHTML = '<section class="workspace-view active"><div class="mm-layout" data-mobile-view="detail" data-mobile-header="pending"></div></section>';
    dispose = installMobileShellState(); expect(document.body.dataset.mobileNavigation).toBe('immersive');
    const layout = document.querySelector<HTMLElement>('.mm-layout')!;
    layout.dataset.mobileHeader = 'embedded'; await flush(); expect(document.body.dataset.mobileNavigation).toBe('immersive');
    layout.dataset.mobileView = 'list'; await flush(); expect(document.body.dataset.mobileNavigation).toBe('standard');
});

it('releases observers and pending focus updates when the app is destroyed', async () => {
    document.body.dataset.mobileNavigation = 'previous'; dispose = installMobileShellState();
    document.dispatchEvent(new Event('focusout')); dispose(); await flush();
    expect(document.body.dataset.mobileNavigation).toBe('previous');
    document.body.innerHTML = '<section class="workspace-view active"><div class="mm-layout" data-mobile-view="detail" data-mobile-header="embedded"></div></section>';
    await flush(); expect(document.body.dataset.mobileNavigation).toBe('previous');
});
