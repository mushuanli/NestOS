import { revealRenderedContent } from '@itookit/mdxeditor';
import { button, element } from './dom';
import { translator, type Translate } from './i18n';
import { clearContentHighlights, highlightContent, type ContentMatch, type SearchContent } from './search-matches';

export type { SearchContent } from './search-matches';
let searchId = 0;
export interface ContentSearchOptions {
    readonly root: HTMLElement;
    readonly history: HTMLElement;
    readonly getContents: () => readonly SearchContent[];
    readonly locale?: string;
    readonly translate?: (key: string) => string;
    readonly onOpen?: () => void;
    readonly onNavigate?: (id: string) => void;
}
export interface ContentSearchView {
    readonly button: HTMLButtonElement;
    readonly element: HTMLElement;
    refresh(): void;
    setActive(active: boolean): void;
    destroy(): void;
}
/** Reuse the same search controls with host-projected, readable content roots. */
export function createContentSearch(options: ContentSearchOptions): ContentSearchView {
    return new ConversationSearch(options.root, options.history, translator(options.locale, options.translate),
        id => options.onNavigate?.(id), { getContents: options.getContents, onOpen: options.onOpen, observe: true });
}
interface SearchBinding {
    getContents?: () => readonly SearchContent[];
    onOpen?: () => void;
    observe?: boolean;
}

export class ConversationSearch {
    readonly button: HTMLButtonElement;
    readonly element = element('section', 'llm-chat__search');
    private readonly input = element('input', 'llm-chat__search-input');
    private readonly status = element('span', 'llm-chat__search-status');
    private readonly previous: HTMLButtonElement;
    private readonly next: HTMLButtonElement;
    private matches: ContentMatch[] = [];
    private index = -1;
    private scheduled = false;
    private active = true;
    private closed = false;
    private readonly observer?: MutationObserver;
    private readonly keydown = (event: KeyboardEvent) => this.handleKey(event);
    constructor(private readonly root: HTMLElement, private readonly history: HTMLElement,
        private readonly t: Translate, private readonly navigating: (id: string) => void, private readonly binding: SearchBinding = {}) {
        this.button = button(t('search'), () => this.toggle());
        this.previous = button(t('searchPrevious'), () => this.move(-1));
        this.next = button(t('searchNext'), () => this.move(1));
        this.layout(); root.addEventListener('keydown', this.keydown);
        if (binding.observe) this.observer = new MutationObserver(() => this.refresh());
    }
    private layout(): void {
        this.element.id = `llm-chat-search-${++searchId}`;
        this.element.hidden = true; this.element.setAttribute('role', 'search'); this.element.setAttribute('aria-label', this.t('search'));
        this.button.setAttribute('aria-controls', this.element.id); this.button.setAttribute('aria-expanded', 'false');
        this.input.type = 'search'; this.input.placeholder = this.t('searchPlaceholder'); this.input.autocomplete = 'off';
        this.input.setAttribute('aria-label', this.t('searchPlaceholder'));
        this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        this.element.append(this.input, this.status, this.previous, this.next,
            button(this.t('searchClose'), () => this.hide()), element('small', 'llm-chat__search-scope', this.t('searchScope')));
        this.input.addEventListener('input', () => { this.index = -1; this.update(); this.reveal(); });
    }
    private toggle(): void { if (this.element.hidden) this.show(); else this.hide(); }
    private show(): void {
        if (this.closed || !this.active) return;
        this.element.hidden = false; this.button.setAttribute('aria-expanded', 'true'); this.update();
        this.binding.onOpen?.();
        this.input.focus(); this.input.select();
    }
    private hide(): void {
        this.element.hidden = true; this.button.setAttribute('aria-expanded', 'false');
        this.observer?.disconnect();
        clearContentHighlights(this.history); this.matches = []; this.index = -1; this.button.focus();
    }
    private handleKey(event: KeyboardEvent): void {
        if (this.closed || !this.active || event.isComposing || event.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault(); this.show(); return;
        }
        if (this.element.hidden) return;
        if (event.key === 'Escape') { event.preventDefault(); this.hide(); }
        if (event.key === 'Enter' && event.target === this.input) {
            event.preventDefault(); this.move(event.shiftKey ? -1 : 1);
        }
    }
    refresh(): void {
        if (this.closed || !this.active || this.element.hidden || this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (!this.closed && this.active && !this.element.hidden) this.update();
        });
    }
    private update(): void {
        this.observer?.disconnect();
        const previous = this.matches[this.index], index = this.index;
        clearContentHighlights(this.history);
        const query = this.input.value.trim(); this.matches = query ? highlightContent(this.history, query, this.binding.getContents?.()) : [];
        const retained = previous ? this.matches.findIndex(match => match.messageId === previous.messageId && match.offset === previous.offset) : -1;
        this.index = !this.matches.length ? -1 : retained >= 0 ? retained : Math.max(0, Math.min(index, this.matches.length - 1));
        this.present();
        this.observe();
    }
    private move(direction: number): void {
        if (!this.matches.length) return;
        this.index = (this.index + direction + this.matches.length) % this.matches.length; this.present(); this.reveal();
    }
    private present(): void {
        const count = this.matches.length;
        const status = count ? `${this.index + 1} / ${count}` : this.input.value.trim() ? this.t('searchNoResults') : '0 / 0';
        if (this.status.textContent !== status) this.status.textContent = status;
        this.previous.disabled = this.next.disabled = !count;
        this.matches.forEach((match, index) => match.marks.forEach(mark => { mark.dataset.active = String(index === this.index); }));
    }
    private reveal(): void {
        const mark = this.matches[this.index]?.marks[0]; if (!mark?.isConnected) return;
        this.navigating(this.matches[this.index].messageId);
        revealRenderedContent(mark, this.history);
        const target = mark.getBoundingClientRect(), viewport = this.history.getBoundingClientRect();
        this.history.scrollTop += target.top - viewport.top - this.history.clientHeight / 2 + target.height / 2;
    }
    private observe(): void {
        if (this.active && !this.closed && !this.element.hidden)
            this.observer?.observe(this.history, { childList: true, characterData: true, subtree: true });
    }
    setActive(active: boolean): void { this.active = active; this.observer?.disconnect(); if (active) this.refresh(); }
    destroy(): void {
        this.closed = true; this.root.removeEventListener('keydown', this.keydown);
        this.observer?.disconnect();
        clearContentHighlights(this.history); this.matches = []; this.element.remove(); this.button.remove();
    }
}
