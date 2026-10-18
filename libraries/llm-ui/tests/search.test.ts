import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../src/i18n';
import { ConversationSearch, createContentSearch } from '../src/search';
import { clearContentHighlights, highlightContent } from '../src/search-matches';

const searches: ConversationSearch[] = [];
afterEach(() => { searches.splice(0).forEach(search => search.destroy()); document.body.replaceChildren(); });
function fixture(content = '<p>Alpha alpha Beta</p>') {
    const root = document.createElement('section'), history = document.createElement('div');
    history.innerHTML = `<article data-message-id="m"><div class="llm-chat__body"><div class="llm-chat__part">${content}</div></div><button>Copy</button></article>`;
    const navigating = vi.fn(), search = new ConversationSearch(root, history, translator(), navigating);
    root.append(search.button, search.element, history); document.body.append(root); searches.push(search);
    const input = search.element.querySelector('input')!, status = search.element.querySelector('[role="status"]')!;
    const query = (value: string) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const key = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = input) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        target.dispatchEvent(event); return event;
    };
    return { root, history, search, input, status, query, key, navigating };
}

describe('conversation content matching', () => {
    it('counts a match across inline Markdown once and preserves links and original marks when cleared', () => {
        const host = fixture('<p>Hello <strong>world</strong> and <a href="https://example.com"><mark>WORLD</mark></a></p>');
        const link = host.history.querySelector('a')!, clicked = vi.fn(); link.addEventListener('click', event => { event.preventDefault(); clicked(); });
        const before = host.history.innerHTML, matches = highlightContent(host.history, 'hello world');
        expect(matches).toHaveLength(1); expect(matches[0].marks.map(mark => mark.textContent)).toEqual(['Hello ', 'world']);
        clearContentHighlights(host.history); expect(host.history.innerHTML).toBe(before);
        expect(highlightContent(host.history, 'world')).toHaveLength(2); clearContentHighlights(host.history);
        expect(host.history.querySelector('a')).toBe(link); expect(host.history.querySelectorAll('mark')).toHaveLength(1);
        link.click(); expect(clicked).toHaveBeenCalledOnce();
    });
    it('treats punctuation literally and excludes controls, editable text and host widgets', () => {
        const host = fixture('<p>[a+b] [A+B]</p><button>secret</button><textarea>secret</textarea><div contenteditable>secret</div><div data-search-exclude>secret</div>');
        expect(highlightContent(host.history, '[a+b]')).toHaveLength(2); clearContentHighlights(host.history);
        expect(highlightContent(host.history, 'secret')).toHaveLength(0);
        expect(highlightContent(host.history, 'Copy')).toHaveLength(0);
        expect(highlightContent(host.history, '')).toHaveLength(0);
    });
    it('does not join separate paragraphs or message parts into a false match', () => {
        const host = fixture('<p>hello</p><p>world</p>');
        host.history.querySelector('.llm-chat__body')!.insertAdjacentHTML('beforeend', '<div class="llm-chat__part">again</div>');
        expect(highlightContent(host.history, 'helloworld')).toHaveLength(0);
        expect(highlightContent(host.history, 'worldagain')).toHaveLength(0);
    });
});

it('observes host-projected content without observing its own highlight changes', async () => {
    const root = document.createElement('section'), history = document.createElement('div'), content = document.createElement('p');
    content.textContent = 'needle'; history.append(content); root.append(history); document.body.append(root);
    const getContents = vi.fn(() => [{ id: 'host-message', element: content }]), navigate = vi.fn();
    const search = createContentSearch({ root, history, getContents, onNavigate: navigate });
    root.append(search.button, search.element);
    try {
        search.button.click(); const input = search.element.querySelector('input')!;
        input.value = 'needle'; input.dispatchEvent(new Event('input'));
        expect(navigate).toHaveBeenCalledWith('host-message');
        content.textContent = 'needle needle';
        await vi.waitFor(() => expect(search.element.querySelector('[role="status"]')!.textContent).toBe('1 / 2'));
        const count = getContents.mock.calls.length;
        await new Promise(resolve => setTimeout(resolve, 10)); expect(getContents).toHaveBeenCalledTimes(count);
        search.destroy(); content.textContent = 'needle needle needle'; await Promise.resolve();
        expect(getContents).toHaveBeenCalledTimes(count); expect(history.querySelector('mark')).toBeNull();
    } finally { search.destroy(); }
});

describe('search controls and lifetime', () => {
    it('creates distinct accessible search controls without Web Crypto', () => {
        vi.stubGlobal('crypto', undefined);
        try {
            const first = fixture(), second = fixture();
            expect(first.search.element.id).not.toBe(second.search.element.id);
            expect(first.search.button.getAttribute('aria-controls')).toBe(first.search.element.id);
            first.search.button.click(); first.query('alpha');
            expect(first.status.textContent).toBe('1 / 2');
        } finally { vi.unstubAllGlobals(); }
    });
    it('opens, counts, wraps navigation and closes without changing message text', () => {
        const host = fixture(), before = host.history.textContent;
        expect(host.search.element.hidden).toBe(true); host.search.button.click();
        expect(document.activeElement).toBe(host.input); expect(host.search.button.getAttribute('aria-expanded')).toBe('true');
        host.query('ALPHA'); expect(host.status.textContent).toBe('1 / 2');
        expect(host.history.querySelectorAll('[data-active="true"]')).toHaveLength(1);
        host.key('Enter'); expect(host.status.textContent).toBe('2 / 2');
        host.key('Enter'); expect(host.status.textContent).toBe('1 / 2');
        host.key('Enter', { shiftKey: true }); expect(host.status.textContent).toBe('2 / 2');
        host.search.element.querySelectorAll('button')[0].click(); expect(host.status.textContent).toBe('1 / 2');
        host.query('missing'); expect(host.status.textContent).toBe('无匹配结果');
        expect([...host.search.element.querySelectorAll('button')].slice(0, 2).every(button => button.disabled)).toBe(true);
        host.key('Escape'); expect(host.search.element.hidden).toBe(true); expect(document.activeElement).toBe(host.search.button);
        expect(host.history.querySelector('mark')).toBeNull(); expect(host.history.textContent).toBe(before);
    });
    it('scopes shortcuts to the view and leaves IME and button activation intact', () => {
        const first = fixture(), second = fixture();
        expect(first.key('f', { ctrlKey: true }, first.root).defaultPrevented).toBe(true);
        expect(first.search.element.hidden).toBe(false); expect(second.search.element.hidden).toBe(true);
        first.query('alpha'); first.key('Enter', { isComposing: true }); expect(first.status.textContent).toBe('1 / 2');
        first.key('Escape', { isComposing: true }); expect(first.search.element.hidden).toBe(false);
        const close = first.search.element.querySelectorAll('button')[2];
        expect(first.key('Enter', {}, close).defaultPrevented).toBe(false); close.click();
        expect(first.search.element.hidden).toBe(true);
        second.key('f', { metaKey: true }, second.root); expect(second.search.element.hidden).toBe(false);
    });
    it('expands matching disclosures and scrolls only the history when navigating', () => {
        const host = fixture('<details><summary>Tool</summary><pre>needle</pre></details>');
        const details = host.history.querySelector('details')!;
        host.search.button.click(); host.query('needle');
        expect(details.open).toBe(true); expect(host.navigating).toHaveBeenCalledOnce();
        const mark = host.history.querySelector('mark')!;
        vi.spyOn(mark, 'getBoundingClientRect').mockReturnValue({ top: 240, height: 20 } as DOMRect);
        vi.spyOn(host.history, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
        Object.defineProperty(host.history, 'clientHeight', { value: 100 });
        host.key('Enter'); expect(host.history.scrollTop).toBe(100); expect(host.root.scrollTop).toBe(0);
    });
    it('refreshes asynchronous content without moving the selection or scrolling', async () => {
        const host = fixture(); host.search.button.click(); host.query('alpha'); host.key('Enter');
        const row = host.history.firstElementChild;
        host.history.querySelector('p')!.textContent = 'Alpha alpha alpha'; host.navigating.mockClear();
        host.search.refresh(); host.search.refresh(); await Promise.resolve();
        expect(host.status.textContent).toBe('2 / 3'); expect(host.navigating).not.toHaveBeenCalled();
        expect(host.history.firstElementChild).toBe(row);
        host.search.setActive(false); host.history.querySelector('p')!.textContent = 'alpha'; host.search.refresh(); await Promise.resolve();
        expect(host.status.textContent).toBe('2 / 3');
        host.search.setActive(true); await Promise.resolve(); expect(host.status.textContent).toBe('1 / 1');
    });
    it('does not reinsert highlights or handle shortcuts after destruction', async () => {
        const host = fixture(); host.search.button.click(); host.query('alpha'); host.search.refresh();
        host.search.destroy(); await Promise.resolve();
        expect(host.history.querySelector('mark')).toBeNull(); expect(host.root.querySelector('[role="search"]')).toBeNull();
        expect(host.key('f', { ctrlKey: true }, host.root).defaultPrevented).toBe(false);
    });
});
