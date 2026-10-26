import { randomUUID, t } from '@itookit/common';
import type { WorkbenchSnapshot, WorkbenchStatePort } from './state';

interface SidebarView {
    section: HTMLElement;
    tab: HTMLButtonElement;
    toggle?: (collapsed: boolean) => void;
    expanded?: boolean;
}

/** Preserves each navigation view while giving the selected one the full sidebar. */
export class WorkbenchSidebar {
    readonly navigation = document.createElement('div');
    private readonly header = document.createElement('div');
    private readonly title = document.createElement('span');
    private readonly tablist = document.createElement('div');
    private readonly openedHost = document.createElement('div');
    private readonly resize = document.createElement('div');
    private readonly views = new Map<string, SidebarView>();
    private readonly abort = new AbortController();
    private readonly releaseWindowList?: () => void;
    private readonly snapshot: WorkbenchSnapshot;
    private changed?: (kind: string) => void;
    constructor(private readonly sidebar: HTMLElement, opened: HTMLElement, private readonly persistence?: WorkbenchStatePort,
        navigationLabel?: string, mountWindowList?: (container: HTMLElement) => () => void) {
        this.snapshot = persistence?.load() ?? {version: 1};
        this.navigation.className = 'workbench-sidebar__navigation'; this.navigation.append(...sidebar.childNodes);
        sidebar.classList.add('workbench-sidebar'); this.header.className = 'workbench-sidebar__header';
        this.title.className = 'workbench-sidebar__title'; this.title.textContent = navigationLabel ?? t('workbench.projects');
        this.tablist.className = 'workbench-sidebar__views'; this.tablist.setAttribute('role', 'tablist');
        this.tablist.setAttribute('aria-label', t('workbench.sidebarViews')); this.header.append(this.title, this.tablist);
        this.openedHost.className = 'workbench-sidebar__opened-host'; this.openedHost.hidden = true; this.openedHost.append(opened);
        sidebar.append(this.header, this.openedHost, this.resize);
        this.releaseWindowList = mountWindowList?.(this.header);
        this.addDrawer('navigation', t('workbench.projects'), this.navigation); this.setupResize();
    }
    get activeView(): string { return this.views.has(this.snapshot.sidebarView ?? '') ? this.snapshot.sidebarView! : 'navigation'; }
    setViewChanged(listener: (kind: string) => void): void { this.changed = listener; }
    selectView(kind: string): void {
        if (!this.views.has(kind) || kind === this.activeView) return;
        this.snapshot.sidebarView = kind; this.apply(); this.save(); this.changed?.(kind);
    }
    addDrawer(kind: string, label: string, body: HTMLElement, toggle?: (collapsed: boolean) => void): () => void {
        const section = document.createElement('div'), tab = document.createElement('button'), id = randomUUID();
        section.className = 'workbench-sidebar__section'; section.dataset.section = kind; section.id = `sidebar-view-${id}`;
        section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', `sidebar-tab-${id}`); section.append(body);
        tab.type = 'button'; tab.className = 'workbench-sidebar__view'; tab.textContent = label; tab.id = `sidebar-tab-${id}`;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', section.id); tab.dataset.sidebarView = kind;
        tab.addEventListener('click', () => this.selectView(kind), {signal: this.abort.signal});
        tab.addEventListener('keydown', event => this.navigateTabs(event, kind), {signal: this.abort.signal});
        this.views.set(kind, {section, tab, toggle}); this.tablist.append(tab); this.openedHost.before(section); this.apply();
        return () => {
            const selected = this.activeView === kind; toggle?.(true); section.remove(); tab.remove(); this.views.delete(kind);
            if (selected) {this.snapshot.sidebarView = 'navigation'; this.changed?.('navigation'); this.save();} this.apply();
        };
    }
    private navigateTabs(event: KeyboardEvent, kind: string): void {
        const keys = [...this.views.keys()], current = keys.indexOf(kind);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1
            : event.key === 'ArrowRight' ? (current + 1) % keys.length : event.key === 'ArrowLeft' ? (current + keys.length - 1) % keys.length : -1;
        if (index < 0) return;
        event.preventDefault(); const next = keys[index]!; this.selectView(next); this.views.get(next)?.tab.focus();
    }
    private setupResize(): void {
        const element = this.resize; element.className = 'workbench-sidebar__resize'; element.tabIndex = 0;
        element.setAttribute('role', 'separator'); element.setAttribute('aria-orientation', 'vertical'); element.setAttribute('aria-label', t('workbench.resizeSidebar'));
        element.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault(); this.width((this.snapshot.width ?? 300) + (event.key === 'ArrowLeft' ? -16 : 16)); this.save();
        }, {signal: this.abort.signal});
        element.addEventListener('pointerdown', event => {
            event.preventDefault(); element.setPointerCapture?.(event.pointerId); let previous = event.clientX;
            const drag = (next: PointerEvent) => {this.width((this.snapshot.width ?? 300) + next.clientX - previous); previous = next.clientX;};
            const stop = () => {element.removeEventListener('pointermove', drag); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); this.save();};
            element.addEventListener('pointermove', drag); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
        }, {signal: this.abort.signal});
        this.apply();
    }
    private width(value: number): void {
        const parentWidth = this.sidebar.parentElement?.clientWidth || 1000;
        this.snapshot.width = Math.max(220, Math.min(value, 600, parentWidth - 360)); this.apply();
    }
    private apply(): void {
        const multiple = this.views.size > 1, selected = this.activeView;
        this.title.hidden = multiple; this.tablist.hidden = !multiple;
        this.sidebar.style.setProperty('--workbench-sidebar-width', `${this.snapshot.width ?? 300}px`);
        for (const [kind, view] of this.views) {
            const expanded = kind === selected;
            view.section.hidden = !expanded; view.tab.tabIndex = expanded ? 0 : -1; view.tab.setAttribute('aria-selected', String(expanded));
            if (multiple) {view.section.setAttribute('role', 'tabpanel'); view.section.setAttribute('aria-labelledby', view.tab.id);}
            else {view.section.removeAttribute('role'); view.section.removeAttribute('aria-labelledby');}
            if (view.expanded !== expanded) {view.expanded = expanded; view.toggle?.(!expanded);}
        }
        this.resize.setAttribute('aria-valuenow', String(this.snapshot.width ?? 300)); this.resize.setAttribute('aria-valuemin', '220'); this.resize.setAttribute('aria-valuemax', '600');
    }
    save(tabs?: WorkbenchSnapshot['tabs']): void {
        if (tabs) this.snapshot.tabs = tabs;
        this.persistence?.save({...this.snapshot});
    }
    destroy(): void {
        this.abort.abort(); this.releaseWindowList?.();
        for (const view of this.views.values()) {view.section.remove(); view.tab.remove();}
        this.views.clear(); this.header.remove(); this.openedHost.remove(); this.resize.remove(); this.sidebar.classList.remove('workbench-sidebar');
    }
}
