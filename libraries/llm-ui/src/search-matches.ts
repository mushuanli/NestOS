interface TextEntry { readonly node: Text; readonly start: number; readonly end: number }
export interface SearchContent { readonly id: string; readonly element: HTMLElement }
export interface ContentMatch { readonly messageId: string; readonly offset: number; readonly marks: HTMLElement[] }
const excluded = 'script,style,button,input,textarea,select,[contenteditable],[data-search-exclude]';
const blocks = 'p,pre,li,h1,h2,h3,h4,h5,h6,summary,td,th,blockquote,.llm-chat__part';

/** Index readable message text without including action controls or host-owned widgets. */
function textEntries(body: HTMLElement): { text: string; entries: TextEntry[] } {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const entries: TextEntry[] = [];
    let text = '', previous: Element | null = null, node: Node | null;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest(excluded) || !node.textContent) continue;
        const block = parent.closest(blocks);
        if (entries.length && block !== previous) text += '\n';
        const start = text.length; text += node.textContent; previous = block;
        entries.push({ node: node as Text, start, end: text.length });
    }
    return { text, entries };
}

/** Literal, case-insensitive matching retains offsets across inline Markdown elements. */
export function highlightContent(history: HTMLElement, query: string, contents?: readonly SearchContent[]): ContentMatch[] {
    const results: ContentMatch[] = [];
    if (!query) return results;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const items = contents ?? [...history.querySelectorAll<HTMLElement>('.llm-chat__body')].map(element => ({
        id: element.closest<HTMLElement>('[data-message-id]')!.dataset.messageId!, element,
    }));
    for (const { id: messageId, element: body } of items) {
        const { text, entries } = textEntries(body);
        const matches = [...text.matchAll(new RegExp(escaped, 'giu'))].map(match => ({
            messageId, offset: match.index!, end: match.index! + match[0].length, marks: [] as HTMLElement[],
        }));
        let cursor = 0;
        for (const entry of entries) {
            while (cursor < matches.length && matches[cursor].end <= entry.start) cursor++;
            const overlaps = [];
            for (let index = cursor; index < matches.length && matches[index].offset < entry.end; index++) overlaps.push(matches[index]);
            if (overlaps.length) markEntry(entry, overlaps);
        }
        results.push(...matches);
    }
    return results;
}

function markEntry(entry: TextEntry, matches: readonly (ContentMatch & { end: number })[]): void {
    const fragment = document.createDocumentFragment(), text = entry.node.data;
    let offset = 0;
    for (const match of matches) {
        const start = Math.max(match.offset, entry.start) - entry.start, end = Math.min(match.end, entry.end) - entry.start;
        fragment.append(document.createTextNode(text.slice(offset, start)));
        const mark = document.createElement('mark'); mark.className = 'llm-chat__search-match'; mark.textContent = text.slice(start, end);
        match.marks.push(mark); fragment.append(mark); offset = end;
    }
    fragment.append(document.createTextNode(text.slice(offset))); entry.node.replaceWith(fragment);
}

export function clearContentHighlights(history: HTMLElement): void {
    const parents = new Set<Node>();
    for (const mark of history.querySelectorAll('mark.llm-chat__search-match')) {
        if (mark.parentNode) parents.add(mark.parentNode);
        mark.replaceWith(...mark.childNodes);
    }
    parents.forEach(parent => parent.normalize());
}
