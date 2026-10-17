// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PromptNavigator } from '../../llm-ui/src/components/PromptNavigator';
import { LayoutTemplates } from '../../llm-ui/src/components/templates/LayoutTemplates';
import { remotePrompts, remoteRounds } from '../../llm-ui/src/shell/remote-rounds';
import { NavigationHelper } from '../../llm-ui/src/shell/NavigationHelper';
import { DOMCache, TimerManager } from '../../llm-ui/src/components/common';
import { ScrollController } from '../../llm-ui/src/components/common/ScrollController';
import { SessionCommand } from '@itookit/llm-session/contracts';
import { t } from '@itookit/common';

const views: Array<{destroy(): void}> = [];
beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: false})));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()});
});
afterEach(() => {
    views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as any).scrollIntoView;
});

function setup(count = 501) {
    const host = document.createElement('div'); host.innerHTML = LayoutTemplates.renderWorkspace('Conversation'); document.body.append(host);
    const history = host.querySelector<HTMLElement>('#llm-ui-history')!;
    history.innerHTML = Array.from({length: count}, (_, i) => `<article class="llm-ui-session is-collapsed" data-session-id="u${i}">Prompt ${i + 1}</article><article class="llm-ui-session" data-session-id="a${i}">Response</article>`).join('');
    history.getBoundingClientRect = () => ({top: 0, height: 400} as DOMRect);
    history.querySelectorAll<HTMLElement>('[data-session-id]').forEach((row, i) => { row.getBoundingClientRect = () => ({top: i * 100} as DOMRect); });
    const scroll = vi.fn(); history.scrollTo = scroll;
    const reveal = vi.fn((id: string) => {
        history.hidden = false;
        const target = [...history.querySelectorAll<HTMLElement>('[data-session-id]')].find(row => row.dataset.sessionId === id)!;
        target.classList.remove('is-collapsed');
        target.getBoundingClientRect = () => ({top: Number(id.slice(1)) * 100 + 100} as DOMRect);
        return target;
    });
    const earlier = vi.fn(), view = new PromptNavigator(host, history, {reveal, earlier}); views.push(view);
    const items = Array.from({length: count}, (_, i) => ({id: 'u' + i, text: `Prompt ${i + 1} — details for a longer conversation ${i === count - 1 ? 'unique tail phrase' : ''}`}));
    view.update(items);
    const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
    const rows = () => [...host.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')];
    return {host, history, view, scroll, reveal, earlier, items, button, rows};
}

it('opens immediately with recent prompts, expands more entries, and reaches old and middle prompts', () => {
    const {host, button, rows, reveal, scroll} = setup(); button('#llm-btn-prompt-nav').click();
    expect(rows()).toHaveLength(100); expect(rows()[0].dataset.promptId).toBe('u500');
    expect(host.querySelector('[data-action="prev"]')).toBeNull();
    button('[data-action="more"]').click(); expect(rows()).toHaveLength(200);
    button('[data-jump="middle"]').click(); expect(document.activeElement?.getAttribute('data-prompt-id')).toBe('u250');
    (document.activeElement as HTMLButtonElement).click(); expect(reveal).toHaveBeenLastCalledWith('u250');
    expect(scroll).toHaveBeenLastCalledWith({top: 25084, behavior: 'instant'});
    button('[data-jump="last"]').click(); (document.activeElement as HTMLButtonElement).click();
    expect(reveal).toHaveBeenLastCalledWith('u500');
    button('[data-jump="first"]').click(); (document.activeElement as HTMLButtonElement).click();
    expect(reveal).toHaveBeenLastCalledWith('u0'); expect(rows()).toHaveLength(501);
    expect(host.querySelector('.llm-prompt-nav__range')?.textContent).toBe(t('chat.promptNav.count', {count: 501, total: 501}));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect((host.querySelector('.llm-prompt-nav') as HTMLElement).hidden).toBe(true);
});

it('shows every prompt for short conversations and clears an old filter when reopened', () => {
    const {host, button, rows} = setup(23); button('#llm-btn-prompt-nav').click();
    expect(rows()).toHaveLength(23); expect(rows()[0].dataset.promptId).toBe('u22');
    const input = host.querySelector<HTMLInputElement>('.llm-prompt-nav__search')!;
    input.value = 'No matching phrase'; input.dispatchEvent(new Event('input')); expect(rows()).toHaveLength(0);
    button('#llm-btn-prompt-nav').click(); button('#llm-btn-prompt-nav').click();
    expect(input.value).toBe(''); expect(rows()).toHaveLength(23);
});

it('searches the full prompt, preserves search and preview mode through updates, and escapes markup', () => {
    const {host, view, items, button, rows} = setup(); button('#llm-btn-prompt-nav').click();
    const input = host.querySelector<HTMLInputElement>('.llm-prompt-nav__search')!;
    input.value = 'unique tail phrase'; input.dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(1); expect(rows()[0].dataset.promptId).toBe('u500');
    button('[data-action="preview"]').click(); expect(button('[data-action="preview"]').getAttribute('aria-pressed')).toBe('true');
    view.update([...items, {id: 'u501', text: 'Unique tail phrase <script>evil</script>'}]);
    expect(rows()).toHaveLength(2); expect(input.value).toBe('unique tail phrase');
    expect(button('[data-action="preview"]').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.llm-prompt-nav script')).toBeNull(); expect(rows()[0].textContent).toContain('<script>evil</script>');
    view.update([]); expect(rows()).toHaveLength(0); expect(host.querySelector('.llm-prompt-nav__empty')).not.toBeNull();
});

it('reveals hidden and collapsed targets without expanding other prompts and closes the mobile sheet', () => {
    const {host, history, button, rows} = setup(3); history.hidden = true;
    vi.mocked(matchMedia).mockImplementation(query => ({matches: query.includes('max-width')} as MediaQueryList));
    button('#llm-btn-prompt-nav').click(); rows()[1].click();
    expect(history.hidden).toBe(false); expect(history.querySelector('[data-session-id="u1"]')?.classList.contains('is-collapsed')).toBe(false);
    expect(history.querySelector('[data-session-id="u0"]')?.classList.contains('is-collapsed')).toBe(true);
    expect((host.querySelector('.llm-prompt-nav') as HTMLElement).hidden).toBe(true);
    expect(document.activeElement?.getAttribute('data-session-id')).toBe('u1');
    expect(button('#llm-btn-prompt-nav').getAttribute('aria-expanded')).toBe('false');
});

it('supports keyboard navigation, focus restoration, outside close, and listener disposal', () => {
    const {host, view, button, rows} = setup(4); button('#llm-btn-prompt-nav').click();
    const input = host.querySelector('input[type="search"]')!;
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true})); expect(document.activeElement).toBe(rows()[0]);
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})); expect(document.activeElement).toBe(rows()[3]);
    rows()[3].dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(document.activeElement).toBe(button('#llm-btn-prompt-nav'));
    button('#llm-btn-prompt-nav').click(); document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    expect((host.querySelector('.llm-prompt-nav') as HTMLElement).hidden).toBe(true);
    view.destroy(); button('#llm-btn-prompt-nav').click(); expect(host.querySelector('.llm-prompt-nav')).toBeNull();
});

it('keeps earlier paging explicit and shows loading and failure without silently fetching history', () => {
    const {host, view, earlier, button} = setup(2); view.setEarlier(true, false, ''); button('#llm-btn-prompt-nav').click();
    expect(earlier).not.toHaveBeenCalled(); button('[data-action="earlier"]').click(); expect(earlier).toHaveBeenCalledOnce();
    view.setEarlier(true, true, ''); button('[data-action="earlier"]').click(); expect(earlier).toHaveBeenCalledOnce();
    view.setEarlier(true, false, 'Page failed'); expect(button('[data-action="earlier"]').disabled).toBe(false);
    expect(host.querySelector('.llm-prompt-nav__scope')?.textContent).toContain('Page failed');
    view.setEarlier(false, false, ''); expect(button('[data-action="earlier"]').hidden).toBe(true);
});

it('retains a focused prompt and preview mode when earlier pages are prepended', () => {
    const {host, view, items, button, rows} = setup(); button('#llm-btn-prompt-nav').click(); button('[data-jump="middle"]').click();
    const focused = document.activeElement?.getAttribute('data-prompt-id');
    button('[data-action="preview"]').click();
    rows().find(row => row.dataset.promptId === focused)!.focus();
    view.update([...Array.from({length: 60}, (_, i) => ({id: 'older' + i, text: 'Older prompt'})), ...items]);
    expect(document.activeElement?.getAttribute('data-prompt-id')).toBe(focused);
    expect(rows()).toHaveLength(251); expect(host.querySelector('.llm-prompt-nav--expanded')).not.toBeNull();
});

it('updates the active prompt while scrolling without rebuilding unchanged entries', async () => {
    const {history, view, items, button, rows} = setup(4); button('#llm-btn-prompt-nav').click();
    const first = rows()[0]; view.update(items.map(item => ({...item}))); expect(rows()[0]).toBe(first);
    history.querySelectorAll<HTMLElement>('[data-session-id]').forEach((row, index) => { row.getBoundingClientRect = () => ({top: index * 100 - 500} as DOMRect); });
    history.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(rows()[0].getAttribute('aria-current')).toBe('location'));
    expect(rows()[3].hasAttribute('aria-current')).toBe(false);
});

it('cancels pending bottom scrolling during navigation and follows new output only after returning to the bottom', async () => {
    const history = document.createElement('div'); document.body.append(history);
    let height = 1000;
    Object.defineProperties(history, {scrollHeight: {get: () => height}, clientHeight: {value: 200}});
    history.scrollTop = 40;
    const scroll = new ScrollController(history); views.push(scroll);
    scroll.scrollToBottom(true); scroll.pauseAutoScroll();
    await new Promise(resolve => setTimeout(resolve, 10)); expect(history.scrollTop).toBe(40);
    scroll.enterStreamingMode(); height = 1400; scroll.handleContentResize(); expect(history.scrollTop).toBe(40);
    history.scrollTop = 1200; history.dispatchEvent(new Event('scroll'));
    height = 1600; scroll.handleContentResize(); expect(history.scrollTop).toBe(1400);
});

it('keeps the latest message in view through keyboard resizing while preserving earlier reading positions', () => {
    let resized = () => {}, height = 500;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {constructor(callback: () => void) {resized = callback;} observe() {} disconnect = disconnect;});
    const history = document.createElement('div');
    Object.defineProperties(history, {scrollHeight: {value: 1500}, clientHeight: {get: () => height}});
    history.scrollTop = 1000;
    const scroll = new ScrollController(history);
    height = 240; history.dispatchEvent(new Event('scroll')); resized(); expect(history.scrollTop).toBe(1260);
    scroll.pauseAutoScroll(); history.scrollTop = 300; height = 500; resized(); expect(history.scrollTop).toBe(300);
    scroll.destroy(); expect(disconnect).toHaveBeenCalledOnce();
});

it('builds stable native prompt identities and excludes only context with explicit known provenance', () => {
    const messages = [
        {id: 'context', role: 'user' as const, turnId: 'one', text: 'Hidden reference', contentParts: ['Hidden reference'], contentPartKinds: ['agents_md.instructions']},
        {id: 'p', role: 'user' as const, turnId: 'one', text: 'real prompt', contentParts: ['real prompt', 'unknown reference'], contentPartKinds: ['user.text', 'unknown']},
        {id: 'a', role: 'assistant' as const, turnId: 'one', text: 'answer'},
        {id: 'p2', role: 'user' as const, turnId: 'two', text: '# AGENTS.md instructions written by user'},
    ];
    const prompts = remotePrompts(messages);
    expect(prompts.map(item => item.text)).toEqual(['real prompt\n\nunknown reference', '# AGENTS.md instructions written by user']);
    expect(prompts.map(item => item.id)).toEqual(remoteRounds(messages).filter(group => group.role === 'user').map(group => group.id));
    expect(remotePrompts(messages.slice(3))[0].id).toBe(prompts[1].id);
});

it('omits context-only native groups while retaining empty attachments and uncertain provenance', () => {
    const prompts = remotePrompts([
        {id: 'context', role: 'user', text: 'Injected only', contentParts: ['Injected only'], contentPartKinds: ['agents_md.instructions']},
        {id: 'attachment', role: 'user', text: ''},
        {id: 'uncertain', role: 'user', text: 'Keep this prompt', contentParts: ['Keep this prompt'], contentPartKinds: ['agents_md.instructions', 'user.text']},
    ]);
    expect(prompts.map(prompt => prompt.text)).toEqual(['', 'Keep this prompt']);
});

it('adapts local current-branch users and opens only the selected history group', async () => {
    const host = document.createElement('div'); host.innerHTML = LayoutTemplates.renderWorkspace('Local'); document.body.append(host);
    const history = host.querySelector<HTMLElement>('#llm-ui-history')!; history.scrollTo = vi.fn();
    history.innerHTML = '<article class="llm-ui-session" data-session-id="user">User</article>';
    const execute = vi.fn(async () => [{id: 'user', role: 'user', content: 'Local user'}, {id: 'assistant', role: 'assistant', content: 'Answer'}]);
    const revealSession = vi.fn(() => history.firstElementChild), timers = new TimerManager(); views.push(timers);
    const navigation = new NavigationHelper({workspace: host, domCache: new DOMCache(host), commands: {execute},
        historyView: {revealSession}, timers} as unknown as ConstructorParameters<typeof NavigationHelper>[0]);
    views.push(navigation); host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-prompt-id]')).toHaveLength(1));
    host.querySelector<HTMLButtonElement>('[data-prompt-id]')!.click();
    expect(execute).toHaveBeenCalledWith(SessionCommand.GetSessions);
    expect(revealSession).toHaveBeenCalledWith('user'); expect(host.querySelector('.llm-prompt-nav__list')?.textContent).not.toContain('Answer');
});

function localNavigation(execute: ReturnType<typeof vi.fn>) {
    const host = document.createElement('div'); host.innerHTML = LayoutTemplates.renderWorkspace('Local'); document.body.append(host);
    const timers = new TimerManager(); views.push(timers);
    const build = vi.fn(async () => ({items: [], branches: []}));
    const navigation = new NavigationHelper({workspace: host, domCache: new DOMCache(host), commands: {execute},
        historyView: {revealSession: vi.fn(), getCollapseStates: () => ({})},
        timers, bus: {emit: vi.fn()}, branchStore: {current: []}, navDataBuilder: {build},
    } as unknown as ConstructorParameters<typeof NavigationHelper>[0]);
    views.push(navigation);
    const openPrompts = () => host.querySelector<HTMLButtonElement>('#llm-btn-prompt-nav')!.click();
    return {host, navigation, build, openPrompts};
}

it('performs no history reads for closed navigation and coalesces prompt-only updates', async () => {
    const execute = vi.fn(async () => [{id: 'u', role: 'user', content: 'Current prompt'}]);
    const {navigation, openPrompts, build} = localNavigation(execute);
    navigation.pushNavData(); navigation.pushNavData(); navigation.pushNavData();
    await new Promise(resolve => setTimeout(resolve, 70)); expect(execute).not.toHaveBeenCalled();
    openPrompts(); await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    navigation.pushNavData(); navigation.pushNavData(); navigation.pushNavData();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(build).not.toHaveBeenCalled();
    openPrompts(); navigation.pushNavData();
    await new Promise(resolve => setTimeout(resolve, 70)); expect(execute).toHaveBeenCalledTimes(2);
});

it('shares an in-flight history read between both navigation panels', async () => {
    let complete!: (sessions: unknown[]) => void;
    const execute = vi.fn(() => new Promise(resolve => {complete = resolve;}));
    const {host, navigation, openPrompts, build} = localNavigation(execute);
    openPrompts(); const opening = navigation.toggleNavigator(host);
    expect(execute).toHaveBeenCalledOnce();
    complete([{id: 'u', role: 'user', content: 'Shared prompt'}]); await opening;
    expect(host.querySelector('[data-prompt-id]')?.textContent).toContain('Shared prompt');
    expect(execute).toHaveBeenCalledOnce(); expect(build).toHaveBeenCalledOnce(); expect(navigation.isNavVisible).toBe(true);
});

it('does not overwrite a newer supplied snapshot with an older in-flight history response', async () => {
    let complete!: (sessions: unknown[]) => void;
    const execute = vi.fn(() => new Promise(resolve => {complete = resolve;}));
    const {host, navigation, openPrompts} = localNavigation(execute);
    openPrompts();
    navigation.updatePrompts([{id: 'new', role: 'user', timestamp: 1, content: 'Latest snapshot'}]);
    complete([{id: 'old', role: 'user', content: 'Stale snapshot'}]);
    await vi.waitFor(() => expect(host.querySelector('[data-prompt-id]')?.textContent).toContain('Latest snapshot'));
    await Promise.resolve(); expect(execute).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-prompt-id="old"]')).toBeNull();
});

it('retries an invalidated in-flight snapshot once and ignores late results after disposal', async () => {
    let complete!: (sessions: unknown[]) => void;
    const execute = vi.fn().mockImplementationOnce(() => new Promise(resolve => {complete = resolve;}))
        .mockResolvedValue([{id: 'new', role: 'user', content: 'Fresh after change'}]);
    const {host, navigation, openPrompts} = localNavigation(execute);
    openPrompts(); navigation.pushNavData(); navigation.pushNavData();
    complete([{id: 'old', role: 'user', content: 'Stale'}]);
    await vi.waitFor(() => expect(host.querySelector('[data-prompt-id]')?.textContent).toContain('Fresh after change'));
    expect(execute).toHaveBeenCalledTimes(2);
    openPrompts(); openPrompts(); navigation.destroy();
    await Promise.resolve(); expect(host.querySelector('.llm-prompt-nav')).toBeNull();
});
