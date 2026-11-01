import type {IFileSystem} from '@itookit/vfs-core';
import {createVFSBrowser, Drawer, VFS_DOM_EVENTS, type VFSBrowser} from '@itookit/vfs-ui';
import {ACTION_ICONS, createModuleLogger, randomUUID} from '@itookit/common';
import {nestOSVFSPresentation} from '../browser/vfs-presentation';
import {createWorkspaceModule} from '../workspaces/module';
import {MailArchive, safeCode, type MailSnapshot} from './read';
import {accountNodes, mailLabel, mailNodes, memorySource} from './source';
const log = createModuleLogger('mail');
interface Options {files: IFileSystem; sidebar: HTMLElement; editor: HTMLElement; selected(path: string): void; scanners(): Promise<void>}
export class MailWorkbench {
    private readonly abort = new AbortController();
    private readonly archive: MailArchive;
    private snapshot: MailSnapshot = {messages: [], sources: [], warnings: []};
    private selectedSource = '';
    private active = '';
    private revision = 0;
    private opening = 0;
    private dirty = false;
    private visible = true;
    private started = false;
    private loading?: Promise<void>;
    private accounts?: VFSBrowser;
    private messages?: VFSBrowser;
    private drawer?: Drawer;
    private stopped?: () => void;
    private alert!: HTMLElement;
    private reader!: HTMLElement;
    constructor(private readonly options: Options) {this.archive = new MailArchive(options.files);}
    async start(): Promise<void> {
        const {sidebar, editor} = this.options;
        sidebar.classList.add('mail__sidebar'); editor.classList.add('mail__reader');
        this.alert = document.createElement('p'); this.alert.className = 'mail__alert'; this.alert.setAttribute('role', 'alert'); this.alert.hidden = true;
        this.reader = document.createElement('article'); this.reader.className = 'mail__document'; editor.append(this.alert, this.reader);
        this.emptyReader();
        this.drawer = new Drawer({title: mailLabel('accounts'), collapsible: true, collapsed: window.matchMedia?.('(max-width: 768px)').matches ?? false});
        const sourceList = document.createElement('div'); sourceList.className = 'mail__accounts'; this.drawer.content.append(sourceList);
        sourceList.addEventListener(VFS_DOM_EVENTS.resourceActivated, event => event.stopPropagation(), {signal: this.abort.signal});
        const list = document.createElement('div'); list.className = 'mail__list'; sidebar.append(this.drawer.element, list);
        this.accounts = createVFSBrowser({container: sourceList, source: memorySource(() => accountNodes(this.snapshot)), presentation: nestOSVFSPresentation, searchPlaceholder: mailLabel('accounts'),
            appearance: {showTitle: false, showTimestamp: false}, onActivate: node => {void this.selectSource(node.id);}, onError: error => this.failure(error, 'source.select')});
        this.messages = createVFSBrowser({container: list, title: mailLabel('title'), searchPlaceholder: mailLabel('search'), presentation: nestOSVFSPresentation,
            source: memorySource(() => mailNodes(this.snapshot, this.selectedSource, this.options.files.viewId)), sort: {by: 'lastModified', direction: 'desc', pinnedFirst: false},
            onActivate: node => {void this.openResource(node.id);}, onError: error => this.failure(error, 'messages.list'), actions: [
                {id: 'refresh', label: mailLabel('refresh'), iconHTML: ACTION_ICONS.refreshView, placements: ['toolbar'], run: async () => {await this.refresh();}},
                {id: 'scanners', label: mailLabel('scanners'), iconHTML: ACTION_ICONS.settings, placements: ['toolbar'], run: async () => this.options.scanners()},
            ]});
        this.stopped = this.options.files.onAny?.(event => {if (event.type.startsWith('node:')) this.invalidateFromEvents();});
        await this.refresh(); await Promise.all([this.accounts.start(), this.messages.start()]); this.started = true;
        if (this.snapshot.sources[0]) this.accounts.expand('provider:' + this.snapshot.sources[0].providerId);
    }
    private async selectSource(id: string): Promise<void> {
        if (id !== 'all' && !id.startsWith('account:')) return;
        this.selectedSource = id === 'all' ? '' : id.slice(8);
        try {await this.messages?.refresh();} catch (error) {this.failure(error, 'source.select');}
        if (window.matchMedia?.('(max-width: 768px)').matches) this.drawer?.setCollapsed(true);
    }
    async openResource(path: string): Promise<void> {
        if (!path || path === '/') return;
        const revision = ++this.opening, operationId = randomUUID(), started = Date.now();
        try {
            const document = await this.archive.document(path, this.abort.signal);
            if (revision !== this.opening || this.abort.signal.aborted) return;
            this.reader.replaceChildren(); this.reader.classList.remove('mm-placeholder');
            const title = documentElement('h2', document.subject), from = documentElement('p', mailLabel('from') + ': ' + document.from);
            const to = documentElement('p', mailLabel('to') + ': ' + document.to), date = documentElement('p', document.date ? new Date(document.date).toLocaleString() : '');
            const body = documentElement('pre', document.body); body.className = 'mail__body';
            this.reader.append(title, from, to, date, body); this.active = path; this.options.selected(path);
            this.options.sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));
            log.info('mail.open', {operationId, stage: 'message.read', result: 'success', durationMs: Date.now() - started});
        } catch (error) {if (revision === this.opening) this.failure(error, 'message.read', operationId, started);}
    }
    getActiveResourceId(): string {return this.active;}
    captureRecovery(): unknown {return {source: this.selectedSource, query: this.messages?.getSnapshot().query ?? ''};}
    restoreRecovery(value: unknown): void {
        const state = value as {source?: unknown; query?: unknown} | null;
        this.selectedSource = typeof state?.source === 'string' ? state.source : '';
        if (typeof state?.query === 'string') this.messages?.setQuery(state.query);
        this.invalidateFromEvents();
    }
    suspendForRecovery(): void {this.abort.abort(); this.stopped?.();}
    async destroy(): Promise<void> {this.suspendForRecovery(); await this.loading; this.messages?.destroy(); this.accounts?.destroy(); this.drawer?.destroy();}
    setVisible(visible: boolean): void {this.visible = visible; if (visible && this.dirty) void this.refresh();}
    invalidateFromEvents(): void {this.dirty = true; if (this.visible) void this.refresh();}
    private refresh(): Promise<void> {
        if (this.abort.signal.aborted) return Promise.resolve();
        return this.loading ??= this.load().finally(() => {this.loading = undefined; if (this.dirty && this.visible && !this.abort.signal.aborted) void this.refresh();});
    }
    private async load(): Promise<void> {
        const revision = ++this.revision; this.dirty = false;
        try {
            const snapshot = await this.archive.read(this.abort.signal);
            if (revision !== this.revision || this.abort.signal.aborted) return;
            this.snapshot = snapshot;
            if (this.selectedSource && !snapshot.sources.some(source => source.id === this.selectedSource)) this.selectedSource = '';
            this.alert.textContent = snapshot.warnings.length ? mailLabel('partial') + ' · ' + [...new Set(snapshot.warnings)].join(', ') : '';
            this.alert.hidden = !snapshot.warnings.length;
            if (this.started) await Promise.all([this.accounts?.refresh(), this.messages?.refresh()]);
        } catch (error) {this.failure(error, 'archive.refresh');}
    }
    private emptyReader(): void {this.reader.classList.add('mm-placeholder'); this.reader.replaceChildren(documentElement('h2', mailLabel('title')), documentElement('p', mailLabel('emptyReader')));}
    private failure(error: unknown, stage: string, operationId = randomUUID(), started = Date.now()): void {
        if (this.abort.signal.aborted) return;
        const code = safeCode(error); this.alert.textContent = mailLabel('failed') + ' · ' + code; this.alert.hidden = false;
        log.warn('mail.view', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
    }
}
function documentElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag); element.textContent = text; return element;
}
export function createMailModule(options: Options) {return createWorkspaceModule(new MailWorkbench(options));}
