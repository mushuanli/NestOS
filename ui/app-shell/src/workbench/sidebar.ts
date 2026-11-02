import {t} from '@itookit/common';
import {Sidebar, type WindowManagementOptions} from '@itookit/vfs-ui';
import {nestOSVFSPresentation} from '../browser/vfs-presentation';
import type {WorkbenchSnapshot, WorkbenchStatePort} from './state';

/** Persist shell preferences while delegating all sidebar controls to vfs-ui. */
export class WorkbenchSidebar {
    readonly navigation: HTMLElement;
    private readonly view: Sidebar;
    private readonly snapshot: WorkbenchSnapshot;
    constructor(private readonly sidebar: HTMLElement, opened: HTMLElement, private readonly persistence?: WorkbenchStatePort,
        navigationLabel?: string, windows?: WindowManagementOptions) {
        this.snapshot = persistence?.load() ?? {version: 1};
        sidebar.classList.add('workbench-sidebar');
        this.view = new Sidebar({container: sidebar, auxiliary: opened, title: navigationLabel ?? t('workbench.projects'),
            navigationLabel: t('workbench.projects'), presentation: nestOSVFSPresentation,
            state: {width: this.snapshot.width, view: this.snapshot.sidebarView},
            changed: state => {this.snapshot.width = state.width; this.snapshot.sidebarView = state.view; this.save();},
            windowManagement: windows});
        this.navigation = this.view.navigation;
    }
    get activeView(): string {return this.view.activeView;}
    setViewChanged(listener: (kind: string) => void): void {this.view.setViewChanged(listener);}
    selectView(kind: string): void {this.view.selectView(kind);}
    addDrawer(kind: string, label: string, body: HTMLElement, toggle?: (collapsed: boolean) => void): () => void {return this.view.addDrawer(kind, label, body, toggle);}
    save(tabs?: WorkbenchSnapshot['tabs']): void {if (tabs) this.snapshot.tabs = tabs; this.persistence?.save({...this.snapshot});}
    destroy(): void {this.view.destroy(); this.sidebar.classList.remove('workbench-sidebar');}
}
