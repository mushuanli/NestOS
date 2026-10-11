import { ENTITY_ICONS, t } from '@itookit/common';
import { VFSUIShell, type BrowserNode, type BrowserSource } from '@itookit/vfs-ui';
import { mindOSVFSPresentation } from '../browser/vfs-presentation';
import { TWIN_PAGES, label } from './view';

/** Project domain pages into the same resource list used by Settings. */
export function twinNavigationSource(): BrowserSource {
    const icons = [ENTITY_ICONS.agent, ENTITY_ICONS.nav, ENTITY_ICONS.history, ENTITY_ICONS.project, ENTITY_ICONS.sync];
    const nodes: BrowserNode[] = TWIN_PAGES.map((page, index) => ({
        id: '/' + page, parentId: null, kind: 'file', label: label(page),
        icon: icons[index], readOnly: true, fileDetails: false,
    }));
    return {
        get: async id => nodes.find(node => node.id === id),
        children: async parent => parent === null ? nodes : [],
        subscribe: () => () => {},
    };
}

export class TwinNavigation {
    private readonly list: VFSUIShell;
    private unsubscribe: () => void;
    private syncing = false;
    private stopped = false;
    private pending = Promise.resolve();

    constructor(container: HTMLElement, navigate: (path: string) => Promise<void>, report: (error: unknown) => void) {
        const rank = (id: string) => TWIN_PAGES.indexOf(id.slice(1) as typeof TWIN_PAGES[number]);
        this.list = new VFSUIShell({
            sessionListContainer: container, source: twinNavigationSource(), title: t('twin.title'),
            searchPlaceholder: t('twin.navigationSearch'),
            presentation: mindOSVFSPresentation, readOnly: true, autoSelectFirst: false,
            persistence: false, hideGitignored: false, toolbar: 'hidden',
            appearance: { showTimestamp: false }, defaultUiSettings: { showSummary: false, showTags: false, showBadges: false },
            sort: { by: 'title', direction: 'asc' }, compareItems: (a, b) => rank(a.id) - rank(b.id),
            listItems: items => items.map(item => ({ ...item, metadata: { ...item.metadata,
                custom: { ...item.metadata.custom, navigationMenu: false } } })),
            contextMenu: { items: () => [], bulkItems: () => [] }, onError: report,
        });
        this.unsubscribe = this.list.on('sessionSelected', ({ item }) => {
            if (this.syncing || this.stopped || !item) return;
            this.pending = this.pending.then(async () => { if (!this.stopped) await navigate(item.id); }).catch(report);
        });
    }

    async start(): Promise<void> { await this.list.start(); }
    async sync(path: string): Promise<void> {
        if (this.stopped || this.list.getSnapshot().activeId === path) return;
        this.syncing = true;
        try { await this.list.selectPath(path); } finally { this.syncing = false; }
    }
    destroy(): void {
        this.stopped = true; this.unsubscribe(); this.list.destroy();
    }
}
