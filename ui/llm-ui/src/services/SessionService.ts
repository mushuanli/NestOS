// @file: llm-ui/services/SessionService.ts


import { SessionCommand, ISessionRepository, SessionSnapshot, type ConversationManifest, type SessionRepositoryChange } from '@itookit/llm-session/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { ChatInputSettings } from '../domain/ports/IChatInputPresenter';

export interface SessionLoadResult {
    sessionId: string;
    snapshot: SessionSnapshot;
    title: string;
    manifest: ConversationManifest;
    settings: ChatInputSettings;
}

/**
 * How long a loaded projection may be reused without re-reading the store. Switching back and
 * forth stays instant, while a session changed by another host is re-read after this bound.
 */
const PROJECTION_TTL_MS = 5_000;

interface CachedProjection {
    at: number;
    title: string;
    manifest: ConversationManifest;
    settings: ChatInputSettings;
}

/**
 * 会话生命周期管理服务
 * 职责：会话的创建、加载、绑定、初始化
 *
 * 切换会话只重新绑定（`SessionCommand.Bind` 仍然每次都发，durable 绑定与监听不能被跳过），
 * 投影（manifest/settings/title）在短 TTL 内复用。仓库每次写入都会通知，通知即失效，
 * 因此本进程内的改动不会被缓存掩盖；跨进程写入最多被 TTL 兜住。
 */
export class SessionService {
    private readonly projections = new Map<string, CachedProjection>();
    private unsubscribe?: () => void;

    constructor(
        private engine: ISessionRepository,
        private commands: ICommandBus,
    ) { }

    async loadSession(sessionId: string, defaultTitle: string, branch?: string): Promise<SessionLoadResult> {
        let snapshot = await this.commands.execute<SessionSnapshot>(SessionCommand.Bind, { sessionId });
        if (branch !== undefined) {
            await this.commands.execute('vcs.branch.switch', { branchName: branch });
            // Branch selection changes the projection; read it without rebinding.
            snapshot = await this.commands.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
            // The cached projection belongs to the branch that was bound before the switch.
            this.projections.delete(sessionId);
        }
        const cached = this.readProjection(sessionId);
        if (cached) {
            return { sessionId, snapshot, title: cached.title, manifest: cached.manifest, settings: cached.settings };
        }
        // The binding already read the projection in the same snapshot; only read the store when
        // the host does not provide it.
        const loaded = snapshot.view
            ?? (this.engine.getLoadState
                ? await this.engine.getLoadState(sessionId)
                : { manifest: await this.engine.getManifest(sessionId), settings: await this.getSessionSettings() });
        const { manifest, settings } = loaded;
        const title = manifest.title || defaultTitle;
        this.subscribeOnce();
        this.projections.set(sessionId, { at: Date.now(), title, manifest, settings });
        return { sessionId, snapshot, title, manifest, settings };
    }

    async renameSession(sessionId: string, newTitle: string): Promise<void> {
        await this.engine.updateManifest(sessionId, { title: newTitle });
    }

    async getSessionSettings(): Promise<ChatInputSettings> {
        return await this.commands.execute<ChatInputSettings>(SessionCommand.GetSettings);
    }

    async saveSessionSettings(settings: ChatInputSettings): Promise<void> {
        await this.commands.execute(SessionCommand.SaveSettings, settings);
    }

    /** Drops every cached projection and stops listening to repository changes. */
    dispose(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.projections.clear();
    }

    private readProjection(sessionId: string): CachedProjection | undefined {
        const cached = this.projections.get(sessionId);
        if (!cached) return undefined;
        if (Date.now() - cached.at > PROJECTION_TTL_MS) {
            this.projections.delete(sessionId);
            return undefined;
        }
        return cached;
    }

    private subscribeOnce(): void {
        this.unsubscribe ??= this.engine.subscribe?.(change => this.invalidate(change));
    }

    /** A write through any host in this process invalidates the projection it touched. */
    private invalidate(change?: SessionRepositoryChange): void {
        if (!change?.sessionId) {
            this.projections.clear();
            return;
        }
        this.projections.delete(change.sessionId);
    }
}
