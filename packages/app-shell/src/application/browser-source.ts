import { t, ENTITY_ICONS } from '@itookit/common';
import type { FSNode } from '@itookit/vfs-core';
import type { BrowserSource, BrowserNode, SourceChange } from '@itookit/vfs-ui';
import type { ApplicationPort, WorkspaceIdentity } from '@itookit/app-core/application/contracts';

/** Presentation interprets resource IDs; neither the browser library nor the port knows HTTP. */
export class ApplicationBrowserSource implements BrowserSource {
    private readonly nodes = new Map<string, BrowserNode>();
    private readonly pages = new Map<string, { nodes: BrowserNode[]; next?: number }>();
    private readonly listeners = new Set<(change: SourceChange) => void>();
    private readonly release: () => void;
    private visible = true;
    private dirty = false;
    constructor(private readonly application: ApplicationPort, private readonly workspace?: WorkspaceIdentity) {
        this.release = application.subscribe(event => {
            if (event.kind === 'invalidate' && (event.scope === 'all' || event.scope === (workspace ? 'files' : 'sessions'))) {
                this.pages.clear(); this.nodes.clear(); this.dirty = true;
                if (this.visible) { this.dirty = false; for (const listener of this.listeners) listener({}); }
            }
        });
    }
    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible && this.dirty) { this.dirty = false; for (const listener of this.listeners) listener({}); }
    }
    subscribe(listener: (change: SourceChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async get(id: string, signal?: AbortSignal): Promise<BrowserNode | undefined> {
        const cached = this.nodes.get(id); if (cached) return cached;
        if (this.workspace && id.startsWith('/')) {
            const node = await this.application.query('entry', { workspace: this.workspace, path: id }, signal);
            return node ? this.file(node) : undefined;
        }
        if (!this.workspace && id.startsWith('session:')) {
            const session = await this.application.query('session', { sessionId: id.slice(8) }, signal);
            return this.remember({ id, parentId: session.folder ?? null, kind: 'file', label: session.title, icon: ENTITY_ICONS.chat });
        }
        return undefined;
    }
    async children(parentId: string | null, signal?: AbortSignal): Promise<readonly BrowserNode[]> {
        const parent = parentId ?? '/';
        if (!this.workspace) return this.sessions(parent, signal);
        const cached = this.pages.get(parent); if (cached) return this.withNext(parent, cached);
        const page = await this.application.query('directory', { workspace: this.workspace, path: parent, limit: 200 }, signal);
        const value = { nodes: page.entries.map(node => this.file(node)), next: page.nextOffset };
        this.pages.set(parent, value); return this.withNext(parent, value);
    }
    private async sessions(parent: string, signal?: AbortSignal): Promise<BrowserNode[]> {
        const folder = parent === '/' ? null : parent;
        const page = await this.application.query('navigation', { folder }, signal);
        return [...page.folders.map(item => this.remember({ id: item.path, parentId: item.parentPath, kind: 'directory' as const,
            label: item.name, expandable: true, presentation: 'drawer' as const, icon: ENTITY_ICONS.project })),
        ...page.sessions.map(item => this.remember({ id: `session:${item.id}`, parentId: item.folder ?? null,
            kind: 'file' as const, label: item.title, modifiedAt: item.updatedAt, icon: ENTITY_ICONS.chat }))];
    }
    private file(node: FSNode): BrowserNode {
        return this.remember({ id: node.path, parentId: node.parentPath === '/' ? null : node.parentPath, kind: node.type === 'directory' ? 'directory' : 'file',
            label: typeof node.metadata.title === 'string' ? node.metadata.title : node.name,
            expandable: node.type === 'directory', ...(node.type === 'directory' ? { presentation: 'drawer' as const } : {}), modifiedAt: node.modifiedAt, createdAt: node.createdAt,
            tags: node.tags, ...(node.type === 'file' ? { size: node.size } : {}), ...(node.icon ? { icon: node.icon } : {}) });
    }
    private remember(node: BrowserNode): BrowserNode { this.nodes.set(node.id, node); return node; }
    private withNext(parent: string, page: { nodes: BrowserNode[]; next?: number }): BrowserNode[] {
        return page.next === undefined ? page.nodes : [...page.nodes, this.remember({ id: `page:${encodeURIComponent(parent)}`, parentId: parent === '/' ? null : parent,
            kind: 'file', label: t('application.loadMore'), expandable: false, readOnly: true })];
    }
    async activate(id: string): Promise<boolean> {
        if (!id.startsWith('page:') || !this.workspace) return false;
        const parent = decodeURIComponent(id.slice(5)), previous = this.pages.get(parent); if (previous?.next === undefined) return true;
        const page = await this.application.query('directory', { workspace: this.workspace, path: parent, offset: previous.next, limit: 200 });
        this.pages.set(parent, { nodes: [...previous.nodes, ...page.entries.map(node => this.file(node))], next: page.nextOffset });
        for (const listener of this.listeners) listener({ parentIds: [parent === '/' ? null : parent] }); return true;
    }
    close(): void { this.release(); this.nodes.clear(); this.pages.clear(); this.listeners.clear(); }
}
