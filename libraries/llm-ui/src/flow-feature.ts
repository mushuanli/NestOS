import type { FlowOptions, FlowView } from './flow-contracts';
import { button, element } from './dom';

export type FlowLoader = () => Promise<{ createFlowView(container: HTMLElement, options: FlowOptions): Promise<FlowView> }>;

/** Feature availability, open state and the execution lifetime are independent. */
export class FlowFeature {
    readonly button: HTMLButtonElement;
    readonly pane = element('div', 'llm-chat__flow');
    private view?: FlowView;
    private generation = 0;
    private enabled = false;
    private open = false;
    private closed = false;
    private active = true;
    private readonly pending = new Set<Promise<void>>();
    constructor(label: string, private readonly options: FlowOptions | undefined,
        report: (error: unknown) => void,
        private readonly load: FlowLoader = () => import('./flow.js')) {
        this.button = button(label, () => { void this.setOpen(!this.open).catch(report); });
        this.button.hidden = true; this.pane.hidden = true;
    }
    async setEnabled(enabled: boolean): Promise<void> {
        if (this.closed) return;
        if (enabled && !this.options) throw new Error('Flow options are required to enable the Flow feature');
        this.enabled = enabled; this.button.hidden = !enabled;
        if (!enabled) await this.setOpen(false);
    }
    private async setOpen(open: boolean): Promise<void> {
        if (this.closed || open && !this.enabled) return;
        this.open = open; this.pane.hidden = !open; this.button.setAttribute('aria-expanded', String(open));
        const generation = ++this.generation;
        const previous = this.view; this.view = undefined;
        if (previous) await previous.destroy();
        if (this.closed || generation !== this.generation) return;
        this.pane.replaceChildren();
        if (!open) return;
        const pending = this.mount(generation); this.pending.add(pending);
        try { await pending; } finally { this.pending.delete(pending); }
    }
    private async mount(generation: number): Promise<void> {
        const module = await this.load();
        if (this.closed || !this.open || !this.enabled || generation !== this.generation) return;
        const mount = element('div'); this.pane.append(mount);
        try {
            const view = await module.createFlowView(mount, this.options!);
            if (this.closed || !this.open || !this.enabled || generation !== this.generation) {
                try { await view.destroy(); } finally { mount.remove(); } return;
            }
            this.view = view; view.setActive(this.active);
        } catch (error) { mount.remove(); throw error; }
    }
    setActive(active: boolean): void { this.active = active; this.view?.setActive(active); }
    async destroy(): Promise<void> {
        this.closed = true; ++this.generation;
        const errors: unknown[] = [];
        for (const task of [...this.pending, this.view?.destroy()]) if (task) {
            try { await task; } catch (error) { errors.push(error); }
        }
        this.pane.remove(); this.button.remove(); this.view = undefined;
        if (errors.length) throw new AggregateError(errors, 'Flow feature disposal failed');
    }
}
