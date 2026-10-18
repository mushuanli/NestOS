// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoryView } from '../../llm-ui-adapter/src/components/HistoryView';
import { LayoutTemplates } from '../../llm-ui-adapter/src/components/templates/LayoutTemplates';
import { remoteRounds } from '../../llm-ui-adapter/src/shell/remote-rounds';

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
        getClientRects: { configurable: true, value: () => [] },
        getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
});
afterEach(() => {
    document.body.replaceChildren(); vi.unstubAllGlobals();
    delete (Range.prototype as any).getClientRects; delete (Range.prototype as any).getBoundingClientRect;
});

function mountSearch() {
    const host = document.createElement('section'); host.className = 'llm-ui-workspace';
    host.innerHTML = LayoutTemplates.renderWorkspace('Chat'); document.body.append(host);
    const view = new HistoryView(host.querySelector<HTMLElement>('#llm-ui-history')!, { readOnly: true });
    const open = () => host.querySelector<HTMLButtonElement>('#llm-btn-search')!.click();
    const query = (text: string) => {
        const input = host.querySelector<HTMLInputElement>('.llm-chat__search-input')!;
        input.value = text; input.dispatchEvent(new Event('input')); return input;
    };
    return { host, view, open, query };
}

it('expands a matching code block before measuring and scrolling without expanding other code', async () => {
    const f = mountSearch();
    try {
        const lines = Array.from({ length: 40 }, (_, index) => index === 39 ? 'needle' : `line ${index}`).join('\n');
        const code = '```text\n' + lines + '\n```\n\n```text\n' + 'other\n'.repeat(40) + '```';
        await f.view.renderSnapshot(remoteRounds([{ id: 'reply', role: 'assistant', text: code, turnId: 'turn' }]));
        f.open();
        const pres = f.host.querySelectorAll('pre');
        expect(pres[0].style.maxHeight).not.toBe('none'); expect(pres[1].style.maxHeight).not.toBe('none');
        let expandedAtMeasurement = false;
        const measure = HTMLElement.prototype.getBoundingClientRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            if (this.matches('mark.llm-chat__search-match')) expandedAtMeasurement = pres[0].style.maxHeight === 'none';
            return measure.call(this);
        });
        f.query('needle');
        expect(f.host.querySelector('.llm-chat__search-status')!.textContent).toBe('1 / 1');
        expect(expandedAtMeasurement).toBe(true);
        expect(f.host.querySelector('[data-active="true"]')!.closest('.mdx-code-block-wrapper--collapsed')).toBeNull();
        expect(pres[1].style.maxHeight).not.toBe('none');
    } finally { await f.view.destroy(); vi.restoreAllMocks(); }
});

it('searches prepended native history in display order and retains the selected match', async () => {
    const f = mountSearch();
    const older = { id: 'older', role: 'user' as const, text: 'needle older', turnId: 'older-turn' };
    const newer = { id: 'newer', role: 'user' as const, text: 'needle newer', turnId: 'newer-turn' };
    try {
        await f.view.renderSnapshot(remoteRounds([newer])); f.open();
        const input = f.query('needle');
        await f.view.renderSnapshot(remoteRounds([older, newer]));
        await vi.waitFor(() => expect(f.host.querySelector('.llm-chat__search-status')!.textContent).toBe('2 / 2'));
        expect(f.host.querySelector('[data-active="true"]')!.parentElement!.textContent).toContain('newer');
        f.query(''); f.query('needle');
        expect(f.host.querySelector('.llm-chat__search-status')!.textContent).toBe('1 / 2');
        expect(f.host.querySelector('[data-active="true"]')!.parentElement!.textContent).toContain('older');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(f.host.querySelector('[data-active="true"]')!.parentElement!.textContent).toContain('newer');
    } finally { await f.view.destroy(); }
});

it.each([false, true])('exposes mobile search outside More in the compatibility history (readOnly=%s)', async readOnly => {
    const host = document.createElement('section'); host.className = 'llm-ui-workspace';
    host.innerHTML = LayoutTemplates.renderWorkspace('Chat'); document.body.append(host);
    const history = host.querySelector<HTMLElement>('#llm-ui-history')!, view = new HistoryView(history, { readOnly });
    try {
        const groups = remoteRounds([{ id: 'user', role: 'user', text: 'needle in old prompt', turnId: 'turn' },
            { id: 'assistant', role: 'assistant', text: 'needle in reply', turnId: 'turn' }]);
        view.renderFull(groups); view.setAllCollapsed(true);
        const button = host.querySelector<HTMLButtonElement>('#llm-btn-search')!;
        expect(button).not.toBeNull(); expect(button.closest('details')).toBeNull(); expect(button.getAttribute('aria-label')).toBe('搜索内容');
        button.click(); const input = host.querySelector<HTMLInputElement>('.llm-chat__search-input')!;
        input.value = 'needle'; input.dispatchEvent(new Event('input'));
        await vi.waitFor(() => expect(host.querySelector('.llm-chat__search-status')!.textContent).toBe('1 / 2'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(host.querySelector('[data-active="true"]')!.closest('.is-collapsed')).toBeNull();
        const root = host.querySelector('.llm-chat__search')!; expect(root.parentElement).toBe(host);
        view.setActive(false); view.setActive(true);
    } finally { await view.destroy(); }
    expect(host.querySelector('#llm-btn-search')).toBeNull(); expect(host.querySelector('.llm-chat__search')).toBeNull();
});
