import { FILE_BROWSER_ICONS, t } from '@itookit/common';
import { decorateButton } from './controls';
import { Drawer } from '@itookit/vfs-ui';
import type { WorkbenchSnapshot, WorkbenchStatePort } from './state';

/** Host-owned section sizes and persistence around reusable presentation drawers. */
export class WorkbenchSidebar {
    readonly navigation = document.createElement('div');
    private readonly top: HTMLElement;
    private readonly bottom: HTMLElement;
    private readonly sections = new Map<HTMLElement, {kind: string; drawer: Drawer; maximize: HTMLButtonElement;
        toggle?: (collapsed: boolean) => void; expanded?: boolean}>();
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
        this.top = this.section(t('workbench.navigation'), this.navigation, 'navigation');
        this.bottom = this.section(t('workbench.opened'), opened, 'opened');
        sidebar.append(this.top, this.divider, this.bottom, this.resize);
        this.splitter(this.divider, 'horizontal', t('workbench.resizeSections'), delta => this.height((this.snapshot.navigationHeight ?? 70) + delta / Math.max(sidebar.clientHeight, 1) * 100));
        this.splitter(this.resize, 'vertical', t('workbench.resizeSidebar'), delta => this.width((this.snapshot.width ?? 300) + delta));
        this.apply();
    }
    private section(label: string, body: HTMLElement, kind: string, toggle?: (collapsed: boolean) => void): HTMLElement {
        const maximize = document.createElement('button'); maximize.type = 'button'; maximize.textContent = t('workbench.maximize');
        decorateButton(maximize, FILE_BROWSER_ICONS.maximize, t('workbench.maximize'), true);
        const drawer = new Drawer({title: label, scrollMode: 'host', onToggle: collapsed => {
            if (kind === 'navigation') this.snapshot.navigationCollapsed = collapsed;
            else if (kind === 'opened') this.snapshot.openedCollapsed = collapsed;
            else (this.snapshot.drawerCollapsed ??= {})[kind] = collapsed;
            this.apply(); this.save();
        }, mountActions: container => {container.append(maximize);} });
        const section = drawer.element;
        section.classList.add('workbench-sidebar__section'); section.dataset.section = kind;
        drawer.content.append(body); this.sections.set(section, {kind, drawer, maximize, toggle});
        maximize.onclick = () => { this.maximized = this.maximized === section ? undefined : section; this.apply(); };
        return section;
    }
    addDrawer(kind: string, label: string, body: HTMLElement, toggle?: (collapsed: boolean) => void): () => void {
        const section = this.section(label, body, kind, toggle);
        section.classList.add('workbench-sidebar__extra'); this.divider.before(section); this.apply();
        return () => { this.sections.get(section)?.drawer.destroy(); this.sections.delete(section);
            if (this.maximized === section) this.maximized = undefined; this.apply(); };
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
        for (const [section, entry] of this.sections) {
            const {kind, drawer, maximize} = entry;
            const collapsed = kind === 'navigation' ? this.snapshot.navigationCollapsed : kind === 'opened'
                ? this.snapshot.openedCollapsed : this.snapshot.drawerCollapsed?.[kind] ?? true;
            if (kind !== 'navigation' && kind !== 'opened') section.style.flex = this.maximized === section ? '1 1 0' : '0 1 240px';
            section.hidden = !!this.maximized && section !== this.maximized;
            drawer.setCollapsed(!!collapsed && this.maximized !== section);
            const expanded = !section.hidden && (!collapsed || this.maximized === section);
            if (entry.expanded !== expanded) {entry.expanded = expanded; entry.toggle?.(!expanded);}
            decorateButton(maximize, this.maximized === section ? FILE_BROWSER_ICONS.restore : FILE_BROWSER_ICONS.maximize, t(this.maximized === section ? 'workbench.restore' : 'workbench.maximize'), true);
        }
        this.divider.hidden = !!this.maximized || !!this.snapshot.navigationCollapsed || !!this.snapshot.openedCollapsed;
        this.resize.setAttribute('aria-valuenow', String(this.snapshot.width ?? 300)); this.resize.setAttribute('aria-valuemin', '220'); this.resize.setAttribute('aria-valuemax', '600');
        this.divider.setAttribute('aria-valuenow', String(this.snapshot.navigationHeight ?? 70)); this.divider.setAttribute('aria-valuemin', '20'); this.divider.setAttribute('aria-valuemax', '85');
    }
    save(tabs?: WorkbenchSnapshot['tabs']): void {
        if (tabs) this.snapshot.tabs = tabs;
        this.persistence?.save({ ...this.snapshot });
    }
    destroy(): void {
        this.abort.abort();
        for (const {drawer} of this.sections.values()) drawer.destroy();
        this.sections.clear(); this.divider.remove(); this.resize.remove(); this.sidebar.classList.remove('workbench-sidebar');
    }
}
