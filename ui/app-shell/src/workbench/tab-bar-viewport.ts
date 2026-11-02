/** Reveal the active tab without scrolling the document or retained editor panels. */
export class TabBarViewport {
    private activeId?: string;
    private frame?: number;
    private observer?: ResizeObserver;
    private closed = false;
    constructor(private readonly bar: HTMLElement) {
        if (typeof ResizeObserver !== 'undefined') {
            this.observer = new ResizeObserver(() => this.reveal()); this.observer.observe(bar);
        }
    }
    update(): void {
        const id = this.bar.querySelector<HTMLElement>('.is-active[data-tab-id]')?.dataset.tabId;
        if (id === this.activeId) return;
        this.activeId = id; this.reveal();
    }
    reveal(): void {
        if (this.closed) return;
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {this.frame = undefined; if (!this.closed) this.scroll();});
    }
    private scroll(): void {
        const tab = this.bar.querySelector<HTMLElement>('.is-active[data-tab-id]');
        if (!tab || !this.bar.isConnected || !this.bar.clientWidth) return;
        const viewport = this.bar.getBoundingClientRect(), target = tab.getBoundingClientRect();
        const pinnedWidth = this.bar.querySelector<HTMLElement>('.workbench-tabs__sidebar-toggle')?.offsetWidth ?? 0;
        const trailingWidth = this.bar.querySelector<HTMLElement>('.workbench-tabs__bar-windows')?.offsetWidth ?? 0;
        const left = viewport.left + this.bar.clientLeft + pinnedWidth, right = viewport.left + this.bar.clientLeft + this.bar.clientWidth - trailingWidth;
        const delta = target.left < left || target.width > right - left ? target.left - left
            : target.right > right ? target.right - right : 0;
        if (!delta) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        this.bar.scrollBy({left: delta, behavior: reduced ? 'instant' : 'smooth'});
    }
    destroy(): void {
        this.closed = true; this.observer?.disconnect();
        if (this.frame !== undefined) cancelAnimationFrame(this.frame); this.frame = undefined;
    }
}
