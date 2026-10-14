import { t } from '@itookit/common';
import { FSError } from '@itookit/vfs-core';
import type { ConversationManifest, SessionSummary, ISessionRepository, SessionFolder } from '@itookit/llm-session';
import { sessionFamilyRoots } from './session-family';

export interface ProjectNavigationSnapshot {
    sessions: readonly SessionSummary[];
    folders: readonly SessionFolder[];
    roots: ReadonlyMap<string, string>;
    pending: readonly { id: string }[];
}
type SessionOrganizationStore = Pick<ISessionRepository, 'list' | 'listSummaries' | 'listFolders' | 'pendingSessionDeletions' | 'getManifest' | 'updateManifest' | 'createSession'>;
/** Organization queries and commands; repository transactions remain the write authority. */
export class ProjectSessions {
    constructor(private readonly repository: SessionOrganizationStore,
        private readonly projectFolders: (folders: readonly SessionFolder[]) => Promise<SessionFolder[]> = async folders => [...folders]) {}
    private summaries(): Promise<SessionSummary[]> {
        return this.repository.listSummaries?.() ?? this.repository.list();
    }
    async navigation(options: { includeSessions?: boolean } = {}): Promise<ProjectNavigationSnapshot> {
        const [sessions, folders, pending] = await Promise.all([
            options.includeSessions === false ? Promise.resolve([]) : this.summaries(), this.repository.listFolders(), this.repository.pendingSessionDeletions(),
        ]);
        return { sessions, folders: await this.projectFolders(folders), pending, roots: sessionFamilyRoots(sessions) };
    }
    async family(id: string): Promise<{ root: string; members: SessionSummary[] }> {
        const snapshot = await this.navigation(), root = snapshot.roots.get(id);
        if (!root) throw new FSError('ENOENT', 'Session not found');
        const members = snapshot.sessions.filter(item => snapshot.roots.get(item.id) === root);
        members.sort((a, b) => a.id === root ? -1 : b.id === root ? 1 : a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return { root, members };
    }
    async moveCandidates(id: string): Promise<SessionSummary[]> {
        const { sessions, folders, pending } = await this.navigation(), source = sessions.find(item => item.id === id);
        if (!source) throw new FSError('ENOENT', 'Session not found');
        const project = projectFor(folders, source.folder), excluded = new Set([id, ...pending.map(item => item.id)]);
        for (let count = -1; count !== excluded.size;) {
            count = excluded.size;
            for (const item of sessions) if (item.parentSessionId && excluded.has(item.parentSessionId)) excluded.add(item.id);
        }
        return sessions.filter(item => !excluded.has(item.id) && project && projectFor(folders, item.folder) === project);
    }
    rename(id: string, title: string): Promise<void> { return this.repository.updateManifest(id, { title }); }
    reparent(id: string, parentSessionId: string | null): Promise<void> { return this.repository.updateManifest(id, { parentSessionId }); }
    create(title: string, folder: string | null): Promise<string> { return this.repository.createSession(title, folder); }
    async createChild(parentSessionId: string): Promise<string> {
        const parent = await this.repository.getManifest(parentSessionId);
        const titles = new Set((await this.summaries()).filter(item => item.folder === parent.folder).map(item => item.title));
        let count = 1; while (titles.has(t('project.childName', { count }))) count++;
        return this.repository.createSession(t('project.childName', { count }), parent.folder, parentSessionId);
    }
    get(id: string): Promise<ConversationManifest> { return this.repository.getManifest(id); }
}
function projectFor(folders: readonly SessionFolder[], path?: string | null): string | undefined {
    return folders.filter(item => item.project && path && (path === item.path || path.startsWith(item.path + '/')))
        .sort((a, b) => b.path.length - a.path.length)[0]?.project?.id;
}
