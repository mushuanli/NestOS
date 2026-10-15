import { harnessObservation as observeHarness } from '@itookit/app-contracts';
import { conversationStatus } from '@itookit/ui-common';
import { resolveBrowserTarget } from '@itookit/app-contracts';
import type { ProjectService } from '@itookit/app-contracts/services';
import type { VFSNodeUI } from '@itookit/vfs-ui';

/** Host presentation over public tree ports; no access to the library's internal DOM. */
export class RemoteSessionStatusView {
    private readonly stops = new Map<string, () => void>();
    private readonly tabs = new Map<string, string>();
    private readonly fileVersions = new Map<string, string>();
    private current?: string;
    private readonly loadedProjects = new Set<string>();
    private visible = true;
    private readonly deadlines = new Map<string, number>();
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private observed = '';
    private revision = 0;
    constructor(private readonly harnessObservation: typeof observeHarness, private readonly projects: ProjectService | undefined, private readonly changed: () => void,
        private readonly tabStatus: (id: string, icon: string, tooltip: string) => void,
        private readonly filesChanged?: (project: string) => void, private readonly tabTitle?: (id: string, title: string) => void,
        private readonly connections?: import('@itookit/app-contracts/services').ConnectionObservation) {}
    project(id?: string) { this.current = id; this.sync(); }
    attach(tab: string, project: string) { this.tabs.set(tab, project); this.sync(); }
    detach(tab: string) { this.tabs.delete(tab); this.deadlines.delete('tab:' + tab); this.sync(); this.scheduleRefresh(); }
    setVisible(visible: boolean) { this.visible = visible; this.sync(); this.scheduleRefresh(); }
    private sync() {
        const interested = this.visible ? [...new Set([this.current, ...this.loadedProjects, ...this.tabs.values()]
            .filter((id): id is string => !!id))].sort() : [];
        const key = JSON.stringify(interested);
        if (key !== this.observed) {
            this.observed = key;
            void this.connections?.update(interested, ++this.revision).catch(error => console.error('[connections]', error));
        }
        const status = this.projects?.remoteMounts?.sessionStatus;
        if (!status) return;
        const ids = new Set(this.visible ? [this.current, ...this.loadedProjects, ...this.tabs.values()].filter((id): id is string => !!id
            && !!this.projects?.remoteMounts?.list(id).some(m => m.at === '/' && m.serverProjectId)) : []);
        for (const [tab, project] of this.tabs) if (!ids.has(project)) this.tabStatus(tab, '', '');
        for (const [id, stop] of this.stops) if (!ids.has(id)) { stop(); this.stops.delete(id); }
        for (const id of ids) if (!this.stops.has(id)) this.stops.set(id, status.subscribe(id, () => {
            this.refreshTabs();
            this.checkFiles(id);
            this.changed();
        }));
    }
    private refreshTabs() {
        const status = this.projects?.remoteMounts?.sessionStatus;
        for (const [tab, project] of this.tabs) {
            let target;
            try { target = resolveBrowserTarget(tab); } catch { continue; }
            if (target.kind !== 'remote' || !target.profileId || !target.nativeSessionId) continue;
            const observation = status?.get(project, target.profileId, target.nativeSessionId);
            const row = status?.record(project, target.profileId, target.nativeSessionId);
            if (row?.title) this.tabTitle?.(tab, row.title);
            const view = observation && conversationStatus(observation);
            this.tabStatus(tab, view?.icon ?? '', view?.tooltip ?? '');
            this.deadline('tab:' + tab, view?.refreshAt);
        }
        this.scheduleRefresh();
    }
    private deadline(id: string, time?: number) {
        if (time === undefined) this.deadlines.delete(id); else this.deadlines.set(id, time);
    }
    private scheduleRefresh() {
        clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
        if (!this.visible || !this.deadlines.size) return;
        const next = Math.min(...this.deadlines.values());
        this.refreshTimer = setTimeout(() => {
            for (const [id, time] of this.deadlines) if (time <= Date.now()) this.deadlines.delete(id);
            this.refreshTabs(); this.changed(); this.scheduleRefresh();
        }, Math.max(0, next - Date.now()));
    }
    private checkFiles(project: string) {
        const version = this.projects?.remoteMounts?.sessionStatus?.fileVersion(project);
        if (version && this.fileVersions.get(project) !== version) { this.fileVersions.set(project, version); this.filesChanged?.(project); }
    }
    items(items: VFSNodeUI[]): VFSNodeUI[] {
        this.loadedProjects.clear();
        for (const id of this.deadlines.keys()) if (id.startsWith('tree:')) this.deadlines.delete(id);
        const projected = this.projectItems(items, this.current);
        this.sync(); this.scheduleRefresh(); return projected;
    }
    private projectItems(items: VFSNodeUI[], inherited?: string): VFSNodeUI[] {
        return items.map(item => {
            const projectId = typeof item.metadata.custom.projectId === 'string' ? item.metadata.custom.projectId : inherited;
            if (projectId && this.loadedProjects.size < 16 && this.projects?.remoteMounts?.list(projectId).length)
                this.loadedProjects.add(projectId);
            let target;
            try { target = resolveBrowserTarget(item.id); } catch { return item; }
            let presentation = item.presentation;
            if (target.kind === 'remote' && target.profileId && target.nativeSessionId) {
                const raw = item.metadata.custom;
                if (projectId && this.loadedProjects.size < 16) this.loadedProjects.add(projectId);
                const observation = projectId && this.projects?.remoteMounts?.sessionStatus?.get(projectId, target.profileId, target.nativeSessionId);
                const view = conversationStatus(observation || this.harnessObservation({id: target.nativeSessionId, title: '', cwd: null,
                    status: typeof raw.remoteStatus === 'string' ? raw.remoteStatus : null,
                    updatedAt: Date.parse(item.metadata.lastModified) || null, resumable: false,
                    statusDetails: raw.remoteStatusDetails as never, lastTurnResult: raw.remoteLastResult as never}, [],
                {source: 'list', observedAt: Number(raw.remoteObservedAt) || 0, stale: Date.now() - Number(raw.remoteObservedAt) > 30_000}));
                presentation = {...presentation, badges: [view.icon + ' ' + view.text], attention: view.tooltip};
                this.deadline('tree:' + projectId + ':' + item.id, view.refreshAt);
            }
            const record = target.kind === 'remote' && target.profileId && target.nativeSessionId && projectId
                ? this.projects?.remoteMounts?.sessionStatus?.record(projectId, target.profileId, target.nativeSessionId) : undefined;
            return {...item, metadata: record?.title ? {...item.metadata, title: record.title} : item.metadata, presentation, children: item.children && this.projectItems(item.children, projectId)};
        });
    }
    async destroy(): Promise<void> {
        this.visible = false; clearTimeout(this.refreshTimer); this.deadlines.clear();
        for (const stop of this.stops.values()) stop();
        this.stops.clear(); this.tabs.clear(); this.loadedProjects.clear(); this.fileVersions.clear();
        await this.connections?.dispose();
    }
}
