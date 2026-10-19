import { ENTITY_ICONS, harnessPresentation, t } from '@itookit/common';
import { FSError, type FSNode } from '@itookit/vfs-core';
import type { SessionFolder } from '@itookit/llm-session/contracts';
import type { HarnessSession, HarnessProfile } from '@itookit/mindos-node-driver';
import { harnessArchiveAllowed } from '@itookit/mindos-node-driver';
import type { ProjectService } from '@itookit/app-contracts/services';
import { reportRemoteFailure } from '../projects/remote-diagnostics';
import { remoteSessionPath, type BrowserTarget } from './browser-routes';
import type { ProjectRemoteMount } from '../projects/remote-mounts';
import type { ConversationSource } from '../projects/conversation-page';
type Target = Extract<BrowserTarget, {kind: 'remote'}>;

/** Only a complete project root binding can expose native conversation profiles. */
export function remoteSessionRootPath(project: SessionFolder, mounts: readonly ProjectRemoteMount[]): string | undefined {
    return project.project && mounts.some(mount => mount.at === '/' && mount.connectionId && mount.serverProjectId)
        ? remoteSessionPath(project.path) : undefined;
}

export class RemoteSessionProjection {
    constructor(private readonly projects?: ProjectService) {}
    private node(path: string, title: string, directory: boolean, times?: Pick<HarnessSession, 'createdAt' | 'updatedAt'>): FSNode {
        const index = path.lastIndexOf('/');
        const base = {path, name: path.slice(index + 1), parentPath: path.slice(0, index), createdAt: times?.createdAt ?? 0, modifiedAt: times?.updatedAt ?? 0,
            version: 1, tags: [], icon: ENTITY_ICONS.remoteSession, metadata: {title, _fileDetails: false, _readOnly: true, _showAll: true, remoteHarness: true}};
        return directory ? {...base, type: 'directory'} : {...base, type: 'file', size: 0};
    }
    private sessionNode(path: string, session: HarnessSession, favorite = false, management?: {rename: boolean; archive: boolean; unarchive: boolean}): FSNode {
        const node = this.node(path, session.title.trim() || t('harness.untitledSession'), false, session);
        return {...node, metadata: {...node.metadata, remoteStatus: session.status, remoteStatusDetails: session.statusDetails,
            remoteLastResult: session.lastTurnResult, remoteOwned: session.owned, remoteParentSessionId: session.parentSessionId,
            remoteBranchName: session.branchName, _favorite: favorite, nativeManagement: management, remoteObservedAt: session.status ? Date.now() : undefined}};
    }
    async root(folder: string, known?: SessionFolder | null): Promise<FSNode[]> {
        const project = known === undefined ? await this.projects?.forFolder(folder) : known;
        const root = project?.project && project.path === folder
            ? remoteSessionRootPath(project, this.projects?.remoteMounts?.list(project.project.id) ?? []) : undefined;
        const node = root && this.node(root, t('harness.remoteSessions'), true);
        return node ? [{ ...node, metadata: { ...node.metadata, navigationTransparent: true } }] : [];
    }
    private sourced(node: FSNode, profile: HarnessProfile): FSNode {
        const source = harnessPresentation(profile.kind, profile.id);
        return {...node, icon: source.icon, metadata: {...node.metadata, harnessKind: profile.kind, harnessLabel: source.label, harnessProfileId: profile.id,
            navigationDescription: source.label}};
    }
    async timeline(project: SessionFolder & {project: {id: string}}, agentId?: string): Promise<{sources: ConversationSource[]; actions: FSNode[]; close(): Promise<void>}> {
        const remote = this.projects?.remoteMounts, root = remote?.list(project.project.id).find(mount => mount.at === '/');
        if (!remote || !remoteSessionRootPath(project, remote.list(project.project.id)) || !root) return {sources: [], actions: [], async close() {}};
        let filterProfile: string | undefined;
        if (agentId) {
            let target: unknown;
            try {target = agentId.startsWith('remote:') ? JSON.parse(agentId.slice(7)) : null;} catch {target = null;}
            if (!Array.isArray(target) || target.length !== 2 || target[0] !== root.connectionId || typeof target[1] !== 'string')
                return {sources: [], actions: [], async close() {}};
            filterProfile = target[1];
        }
        let client: import('@itookit/mindos-node-driver').HarnessClient | undefined;
        try {
            client = await remote.projectHarness(project.project.id, {timeoutMs: 3000});
            const profiles = (await client.profiles({timeoutMs: 3000})).profiles.filter(profile => profile.projectRuntime && (!filterProfile || profile.id === filterProfile));
            if (root.serverId) await this.projects!.favorites.list(project.project.id);
            const active = client;
            return {sources: profiles.filter(profile => profile.capabilities.history).map(profile => ({id: 'remote:' + profile.id,
                read: cursor => this.timelinePage(active, project, root, profile, cursor)})),
                actions: profiles.flatMap(profile => this.timelineActions(project.path, profile, root)), close: () => active.close()};
        } catch (error) {
            await client?.close(); reportRemoteFailure(error, {stage: 'session-list', projectId: project.project.id});
            return {sources: [{id: 'remote', async read() {throw error;}}], actions: [], async close() {}};
        }
    }
    private async timelinePage(client: import('@itookit/mindos-node-driver').HarnessClient, project: SessionFolder & {project: {id: string}},
        root: ProjectRemoteMount, profile: HarnessProfile, cursor?: string) {
        try {
            const page = await client.list(profile.id, {cursor}, {timeoutMs: 3000});
            return {nodes: page.sessions.map(session => this.sourced(this.sessionNode(remoteSessionPath(project.path, profile.id, session.id), session,
                this.favorite(project.project.id, root, profile.id, session.id), this.management(profile, root, session)), profile)), nextCursor: page.nextCursor ?? undefined};
        } catch (error) {reportRemoteFailure(error, {stage: 'session-list', projectId: project.project.id, profileId: profile.id}); throw error;}
    }
    private timelineActions(folder: string, profile: HarnessProfile, root: ProjectRemoteMount): FSNode[] {
        const {label} = harnessPresentation(profile.kind, profile.id);
        return [
            ...(profile.capabilities.create && (profile.projectCapabilities?.sessionControl ?? root.access === 'rw')
                ? [this.sourced(this.node(remoteSessionPath(folder, profile.id) + '/@new', t('project.createWith', {name: label}), false), profile)] : []),
            ...(profile.capabilities.history ? [this.sourced(this.node(remoteSessionPath(folder, profile.id, undefined, true), `${label} · ${t('harness.archivedSessions')}`, true), profile)] : []),
        ];
    }
    async list(path: string, target: Target): Promise<FSNode[]> {
        const project = await this.projects?.forFolder(target.folder), remote = this.projects?.remoteMounts;
        if (!remote || !project || project.path !== target.folder) throw new FSError('ENOENT', 'Remote project unavailable');
        if (target.nativeSessionId || target.draft) return [];
        let client: import('@itookit/mindos-node-driver').HarnessClient | undefined;
        try {
            client = await remote.projectHarness(project.project.id, {timeoutMs: 3000});
            const profiles = (await client.profiles({timeoutMs: 3000})).profiles.filter(p => p.projectRuntime && (p.capabilities.history || p.capabilities.create));
            if (!target.profileId) return profiles.map(p => this.node(remoteSessionPath(target.folder, p.id), p.kind === p.id ? p.id : `${p.kind} · ${p.id}`, true));
            const profile = profiles.find(p => p.id === target.profileId || p.aliases?.includes(target.profileId!));
            if (!profile) throw new FSError('ENOENT', 'Remote profile unavailable');
            const page = profile.capabilities.history ? await client.list(profile.id, {cursor: target.cursor, ...(target.archived ? {archived: true} : {})}, {timeoutMs: 3000}) : {sessions: [], nextCursor: null};
            const root = remote.list(project.project.id).find(m => m.at === '/')!;
            if (root.serverId) await this.projects?.favorites?.list(project.project.id);
            return [ ...(profile.capabilities.create && (profile.projectCapabilities?.sessionControl ?? root.access === 'rw') && !target.cursor && !target.archived ? [this.node(path + '/@new', t('harness.create'), false)] : []),
                ...(profile.capabilities.history && !target.cursor && !target.archived ? [this.node(path + '/@archived', t('harness.archivedSessions'), true)] : []),
                ...page.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
                    .map(s => this.sourced(this.sessionNode(path + '/' + encodeURIComponent(s.id), s, [profile.id, ...(profile.aliases ?? [])].some(id => this.favorite(project.project.id, root, id, s.id)),
                        this.management(profile, root, s, target.archived)), profile)),
                ...(page.nextCursor ? [this.node(path + '/@page:' + encodeURIComponent(page.nextCursor), t('harness.more'), true)] : []) ];
        } catch (error) {
            reportRemoteFailure(error, {stage: 'session-list', projectId: project.project.id, profileId: target.profileId});
            const node = this.node(path + '/unavailable', t('harness.disconnected'), false);
            return [{...node, metadata: {...node.metadata, _disabled: true}}];
        } finally { await client?.close(); }
    }
    async stat(path: string, target: Target): Promise<FSNode | null> {
        if (!target.profileId) return (await this.root(target.folder))[0] ?? null;
        if (!target.nativeSessionId) return this.node(path, target.draft ? t('harness.create') : target.cursor ? t('harness.more') : target.archived ? t('harness.archivedSessions') : target.profileId, !target.draft);
        const project = await this.projects?.forFolder(target.folder), remote = this.projects?.remoteMounts;
        if (!remote || !project || project.path !== target.folder) return null;
        const client = await remote.projectHarness(project.project.id, {timeoutMs: 3000});
        try { const history = await (client.inspect ? client.inspect(target.profileId, target.nativeSessionId, {timeoutMs: 3000}) : client.read(target.profileId, target.nativeSessionId, {timeoutMs: 3000}));
            const root = remote.list(project.project.id).find(m => m.at === '/')!;
            if (root.serverId) await this.projects?.favorites?.list(project.project.id);
            const profile = (await client.profiles({timeoutMs: 3000})).profiles.find(profile => profile.id === target.profileId || profile.aliases?.includes(target.profileId!));
            const node = this.sessionNode(path, history.session, this.favorite(project.project.id, root, target.profileId, target.nativeSessionId),
                profile && this.management(profile, root, history.session, target.archived));
            return profile ? this.sourced(node, profile) : node;
        } finally { await client.close(); }
    }
    private management(profile: HarnessProfile, root: ProjectRemoteMount, session: HarnessSession, archived = false) {
        const caps = profile.capabilities;
        if (!(profile.projectCapabilities?.sessionControl ?? root.access === 'rw') || !caps.rename && !caps.archive && !caps.unarchive && !caps.delete) return;
        return {delete: !!caps.delete && (archived && session.status === 'notLoaded' || !!session.owned && session.status === 'idle'), rename: !!caps.rename, archive: !archived && !!caps.archive, archiveDisabled: !harnessArchiveAllowed(session), unarchive: archived && !!caps.unarchive};
    }
    private favorite(projectId: string, root: ProjectRemoteMount, profileId: string, sessionId: string): boolean {
        return !!root.serverId && !!root.connectionId && !!root.serverProjectId && !!this.projects?.favorites.has(projectId,
            {kind: 'remote-session', connectionId: root.connectionId, serverId: root.serverId, serverProjectId: root.serverProjectId, profileId, sessionId});
    }
}
