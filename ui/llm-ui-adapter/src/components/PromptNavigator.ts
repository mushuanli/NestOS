import { t } from '@itookit/common';
import { EventCleanup } from './common/EventCleanup';
import { PromptNavigationTemplates as templates } from './templates/PromptNavigationTemplates';

export interface PromptNavigationItem { id: string; text: string }
export interface PromptNavigationOptions {
    reveal(id: string): HTMLElement | null;
    refresh?(): void;
    earlier?(): void;
}

const INITIAL_COUNT = 100;
let panelSequence = 0;

/** A bounded, read-only index of user prompts, independent of execution and branch commands. */
export class PromptNavigator {
    private readonly panel = document.createElement('section');
    private readonly events = new EventCleanup();
    private readonly trigger: HTMLButtonElement;
    private items: PromptNavigationItem[] = [];
    private filtered: PromptNavigationItem[] = [];
    private query = '';
    private visibleCount = INITIAL_COUNT;
    private hasEarlier = false;
    private loading = false;
    private activeId?: string;
    private frame?: number;
    private destroyed = false;

    constructor(workspace: HTMLElement, private history: HTMLElement, private options: PromptNavigationOptions) {
        this.trigger = workspace.querySelectorAll<HTMLButtonElement>('#llm-btn-prompt-nav')[0]!;
        this.panel.className = 'llm-prompt-nav'; this.panel.hidden = true;
        this.panel.id = `llm-prompt-navigation-${++panelSequence}`;
        this.trigger.setAttribute('aria-controls', this.panel.id);
        this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', t('chat.promptNav.title'));
        this.panel.innerHTML = templates.shell(); workspace.append(this.panel);
        this.events.add(this.trigger, 'click', () => this.toggle());
        this.events.add(this.panel, 'click', event => this.click(event));
        this.events.add(this.panel, 'keydown', event => this.keydown(event as KeyboardEvent));
        this.events.add(this.panel.querySelector('input')!, 'input', event => {
            this.query = (event.target as HTMLInputElement).value; this.visibleCount = INITIAL_COUNT; this.filter(); this.render();
        });
        this.events.add(document, 'pointerdown', event => {
            if (!this.panel.hidden && !this.panel.contains(event.target as Node) && !this.trigger.contains(event.target as Node)) this.close(false);
        });
        this.events.add(document, 'keydown', event => {
            if ((event as KeyboardEvent).key !== 'Escape' || this.panel.hidden || !workspace.contains(document.activeElement)) return;
            event.preventDefault(); this.close();
        });
        this.events.add(this.history, 'scroll', () => this.scheduleHighlight(), {passive: true});
    }

    get isVisible(): boolean { return !this.panel.hidden; }

    update(items: PromptNavigationItem[]): void {
        if (this.destroyed) return;
        const changed = items.length !== this.items.length || items.some((item, index) => item.id !== this.items[index]?.id || item.text !== this.items[index]?.text);
        this.items = items;
        if (!changed) return;
        this.filter();
        if (!this.panel.hidden) {
            this.syncActive();
            this.render();
        }
    }

    setEarlier(available: boolean, loading: boolean, error: string): void {
        this.hasEarlier = available; this.loading = loading;
        const button = this.panel.querySelector<HTMLButtonElement>('[data-action="earlier"]')!;
        button.hidden = !available || !this.options.earlier; button.disabled = loading;
        button.textContent = t(loading ? 'harness.loadingEarlier' : 'harness.earlierHistory');
        const hint = this.panel.querySelector<HTMLElement>('.llm-prompt-nav__scope')!;
        hint.hidden = !available;
        hint.textContent = t('chat.promptNav.loadedOnly') + (error ? ` ${error}` : '');
        if (!this.panel.hidden && !this.filtered.length) this.render();
    }

    toggle(): void {
        if (!this.panel.hidden) { this.close(); return; }
        this.panel.hidden = false; this.trigger.setAttribute('aria-expanded', 'true');
        this.query = ''; this.visibleCount = INITIAL_COUNT;
        this.panel.querySelector<HTMLInputElement>('input')!.value = '';
        this.filter(); this.syncActive(); this.render();
        this.panel.querySelector('.llm-prompt-nav__list')!.scrollTop = 0;
        this.panel.querySelector<HTMLInputElement>('input')!.focus();
        this.options.refresh?.();
    }

    private close(restoreFocus = true): void {
        this.panel.hidden = true; this.trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.trigger.focus({preventScroll: true});
    }

    private filter(): void {
        const query = this.query.trim().toLocaleLowerCase();
        this.filtered = (query ? this.items.filter(item => item.text.toLocaleLowerCase().includes(query)) : [...this.items]).reverse();
    }

    private render(): void {
        const list = this.panel.querySelector<HTMLElement>('.llm-prompt-nav__list')!;
        const focusedId = (document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-prompt-id]')?.dataset.promptId;
        const top = list.scrollTop;
        const visible = this.filtered.slice(0, this.visibleCount);
        const ordinals = new Map(this.items.map((item, index) => [item.id, index + 1]));
        const empty = this.loading ? 'harness.loadingEarlier' : this.hasEarlier && !this.query ? 'chat.promptNav.noLoadedPrompts' : 'chat.promptNav.empty';
        list.innerHTML = visible.map(item => templates.item(item, ordinals.get(item.id)!, item.id === this.activeId)).join('') || templates.empty(empty);
        this.panel.querySelector<HTMLElement>('.llm-prompt-nav__range')!.textContent = t('chat.promptNav.count', {count: visible.length, total: this.filtered.length});
        this.panel.querySelector<HTMLButtonElement>('[data-action="more"]')!.hidden = visible.length >= this.filtered.length;
        this.panel.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach(button => { button.disabled = !this.filtered.length; });
        const focused = [...list.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')].find(button => button.dataset.promptId === focusedId);
        focused?.focus({preventScroll: true}); list.scrollTop = top;
    }

    private click(event: Event): void {
        const target = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!target) return;
        if (target.dataset.promptId) { this.select(target.dataset.promptId); return; }
        if (target.dataset.jump) { this.jump(target.dataset.jump); return; }
        this.action(target.dataset.action ?? '');
    }

    private action(action: string): void {
        if (action === 'close') this.close();
        if (action === 'earlier') this.options.earlier?.();
        if (action === 'preview') {
            const expanded = this.panel.classList.toggle('llm-prompt-nav--expanded');
            this.panel.querySelector('[data-action="preview"]')!.setAttribute('aria-pressed', String(expanded));
        }
        if (action === 'more') {
            this.visibleCount += INITIAL_COUNT; this.render();
        }
    }

    private jump(position: string): void {
        const index = position === 'last' ? 0 : position === 'middle' ? Math.floor((this.filtered.length - 1) / 2) : this.filtered.length - 1;
        const item = this.filtered[index]; if (!item) return;
        this.visibleCount = Math.max(this.visibleCount, index + 1); this.render();
        const button = [...this.panel.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')].find(row => row.dataset.promptId === item.id);
        button?.focus(); button?.scrollIntoView?.({block: 'nearest'});
    }

    private select(id: string): void {
        const target = this.options.reveal(id); if (!target) return;
        this.activeId = id; this.highlight();
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const offset = target.getBoundingClientRect().top - this.history.getBoundingClientRect().top - 16;
        const behavior = reduced || Math.abs(offset) > this.history.clientHeight * 2 ? 'instant' : 'smooth';
        this.history.scrollTo({top: Math.max(0, this.history.scrollTop + offset), behavior});
        this.history.querySelectorAll('.llm-prompt-nav-target').forEach(row => row.classList.remove('llm-prompt-nav-target'));
        target.classList.add('llm-prompt-nav-target'); target.tabIndex = -1;
        if (window.matchMedia?.('(max-width: 600px)').matches) this.close(false);
        target.focus({preventScroll: true});
    }

    private scheduleHighlight(): void {
        if (this.panel.hidden || this.frame !== undefined) return;
        this.frame = requestAnimationFrame(() => { this.frame = undefined; this.syncActive(); this.highlight(); });
    }

    private syncActive(): void {
        const ids = new Set(this.items.map(item => item.id));
        const bounds = this.history.getBoundingClientRect(), line = bounds.top + bounds.height * .4;
        let first: string | undefined, current: string | undefined;
        for (const row of this.history.querySelectorAll<HTMLElement>('.llm-ui-session')) {
            if (!ids.has(row.dataset.sessionId!)) continue;
            first ??= row.dataset.sessionId;
            if (row.getBoundingClientRect().top <= line) current = row.dataset.sessionId;
        }
        this.activeId = current ?? first;
    }

    private highlight(): void {
        this.panel.querySelectorAll<HTMLElement>('[data-prompt-id]').forEach(row => {
            if (row.dataset.promptId === this.activeId) row.setAttribute('aria-current', 'location');
            else row.removeAttribute('aria-current');
        });
    }

    private keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
        const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
        if (!keys.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        const input = event.target instanceof HTMLInputElement;
        if (input && event.key !== 'ArrowDown') return;
        const rows = [...this.panel.querySelectorAll<HTMLButtonElement>('[data-prompt-id]')];
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        if (rows[next]) { event.preventDefault(); rows[next].focus(); rows[next].scrollIntoView?.({block: 'nearest'}); }
    }

    destroy(): void {
        this.destroyed = true; this.events.cleanup();
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.removeAttribute('aria-controls'); this.panel.remove();
        this.history.querySelectorAll('.llm-prompt-nav-target').forEach(row => row.classList.remove('llm-prompt-nav-target'));
    }
}
