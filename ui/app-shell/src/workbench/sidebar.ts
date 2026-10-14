import { FILE_BROWSER_ICONS, t } from '@itookit/common';
import { decorateButton } from './controls';
import type { WorkbenchSnapshot, WorkbenchStatePort } from './state';

/** One sidebar, two independently scrollable sections and keyboard accessible splitters. */
export class WorkbenchSidebar {
    readonly navigation = document.createElement('div');
    private readonly top = document.createElement('section');
    private readonly bottom = document.createElement('section');
    private readonly divider = document.createElement('div');
    private readonly resize = document.createElement('div');
    private readonly abort = new AbortController();
    private snapshot: WorkbenchSnapshot;
    private maximized?: HTMLElement;
    constructor(private readonly sidebar: HTMLElement, opened: HTMLElement, private readonly persistence?: WorkbenchStatePort) {
        this.snapshot = persistence?.load() ?? { version: 1 };
        const previous = [...sidebar.childNodes];
        sidebar.classList.add('workbench-sidebar'); this.navigation.className = 'workbench-sidebar__navigation';
        this.navigation.append(...previous);
        this.section(this.top, t('workbench.navigation'), this.navigation, 'navigation');
        this.section(this.bottom, t('workbench.opened'), opened, 'opened');
        sidebar.append(this.top, this.divider, this.bottom, this.resize);
        this.splitter(this.divider, 'horizontal', t('workbench.resizeSections'), delta => this.height((this.snapshot.navigationHeight ?? 70) + delta / Math.max(sidebar.clientHeight, 1) * 100));
        this.splitter(this.resize, 'vertical', t('workbench.resizeSidebar'), delta => this.width((this.snapshot.width ?? 300) + delta));
        this.apply();
    }
    private section(section: HTMLElement, label: string, body: HTMLElement, kind: 'navigation' | 'opened'): void {
        section.className = 'workbench-sidebar__section'; section.dataset.section = kind;
        const header = document.createElement('div'); header.className = 'workbench-sidebar__header';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = label;
        decorateButton(toggle, FILE_BROWSER_ICONS.chevron, label);
        toggle.onclick = () => { const key = kind === 'navigation' ? 'navigationCollapsed' : 'openedCollapsed'; this.snapshot[key] = !this.snapshot[key]; this.apply(); this.save(); };
        const maximize = document.createElement('button'); maximize.type = 'button'; maximize.textContent = t('workbench.maximize');
        decorateButton(maximize, FILE_BROWSER_ICONS.maximize, t('workbench.maximize'), true);
        maximize.onclick = () => { this.maximized = this.maximized === section ? undefined : section; this.apply(); };
        header.append(toggle, maximize); section.append(header, body);
    }
    private splitter(element: HTMLElement, orientation: 'horizontal' | 'vertical', label: string, move: (delta: number) => void): void {
        element.className = orientation === 'horizontal' ? 'workbench-sidebar__divider' : 'workbench-sidebar__resize';
        element.tabIndex = 0; element.setAttribute('role', 'separator'); element.setAttribute('aria-orientation', orientation); element.setAttribute('aria-label', label);
        element.addEventListener('keydown', event => {
            const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp', increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
            if (event.key !== decrease && event.key !== increase) return;
            event.preventDefault(); move(event.key === decrease ? -16 : 16); this.save();
        }, { signal: this.abort.signal });
        element.addEventListener('pointerdown', event => {
            event.preventDefault(); element.setPointerCapture?.(event.pointerId);
            let previous = orientation === 'vertical' ? event.clientX : event.clientY;
            const drag = (event: PointerEvent) => { const next = orientation === 'vertical' ? event.clientX : event.clientY; move(next - previous); previous = next; };
            const stop = () => { element.removeEventListener('pointermove', drag); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); this.save(); };
            element.addEventListener('pointermove', drag); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
        }, { signal: this.abort.signal });
    }
    private width(value: number): void {
        const parentWidth = this.sidebar.parentElement?.clientWidth || 1000;
        this.snapshot.width = Math.max(220, Math.min(value, 600, parentWidth - 360)); this.apply();
    }
    private height(value: number): void { this.snapshot.navigationHeight = Math.max(20, Math.min(85, value)); this.apply(); }
    private apply(): void {
        this.sidebar.style.setProperty('--workbench-sidebar-width', `${this.snapshot.width ?? 300}px`);
        this.top.style.flex = `${this.snapshot.navigationHeight ?? 70} 1 0`; this.bottom.style.flex = `${100 - (this.snapshot.navigationHeight ?? 70)} 1 0`;
        for (const section of [this.top, this.bottom]) {
            const collapsed = section === this.top ? this.snapshot.navigationCollapsed : this.snapshot.openedCollapsed;
            section.hidden = !!this.maximized && section !== this.maximized;
            section.classList.toggle('is-collapsed', !!collapsed && this.maximized !== section);
            const buttons = section.querySelectorAll('button'); buttons[0]?.setAttribute('aria-expanded', String(!collapsed || this.maximized === section));
            if (buttons[1]) decorateButton(buttons[1], this.maximized === section ? FILE_BROWSER_ICONS.restore : FILE_BROWSER_ICONS.maximize, t(this.maximized === section ? 'workbench.restore' : 'workbench.maximize'), true);
        }
        this.divider.hidden = !!this.maximized || !!this.snapshot.navigationCollapsed || !!this.snapshot.openedCollapsed;
        this.resize.setAttribute('aria-valuenow', String(this.snapshot.width ?? 300)); this.resize.setAttribute('aria-valuemin', '220'); this.resize.setAttribute('aria-valuemax', '600');
        this.divider.setAttribute('aria-valuenow', String(this.snapshot.navigationHeight ?? 70)); this.divider.setAttribute('aria-valuemin', '20'); this.divider.setAttribute('aria-valuemax', '85');
    }
    save(tabs?: WorkbenchSnapshot['tabs']): void {
        if (tabs) this.snapshot.tabs = tabs;
        this.persistence?.save({ ...this.snapshot });
    }
    destroy(): void { this.abort.abort(); this.top.remove(); this.bottom.remove(); this.divider.remove(); this.resize.remove(); this.sidebar.classList.remove('workbench-sidebar'); }
}
