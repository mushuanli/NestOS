import { ApplicationConfiguration } from './configuration';
import { FSError } from '@itookit/vfs-core';
import { type ICommandBus, type SessionSnapshot, type SessionViewPort } from '@itookit/llm-session/contracts';
import type { ApplicationRuntime } from '../runtime/create-application-runtime';
import { ApplicationFiles } from './files';
import { validateApplicationQuery, validateApplicationCommand } from './validation';
import { readApplicationFile, saveApplicationFile } from './file-content';
import { APPLICATION_CONVERSATION_COMMANDS, APPLICATION_READ_COMMANDS } from './conversation-policy';
import { workspaceRoot } from '../session/workspace-paths';
import { APPLICATION_PROTOCOL_VERSION, type ApplicationPort, type ApplicationEvent, type ApplicationChange, type ApplicationQueries, type ApplicationCommands } from './contracts';

export interface ConversationClient {
    sessionManager: Pick<SessionViewPort, 'onEvent' | 'onGlobalEvent'> & { getSnapshot(): SessionSnapshot };
    commandBus: ICommandBus;
}
export { APPLICATION_CONVERSATION_COMMANDS } from './conversation-policy';
const safeCommands = new Set<string>(APPLICATION_CONVERSATION_COMMANDS);
const readCommands = new Set<string>(APPLICATION_READ_COMMANDS);

/** A client owns a view binding; the host keeps the filesystem, execution and leases. */
export class LocalApplicationPort implements ApplicationPort {
    private closed = false;
    private configurationEventQueued = false;
    private revision = 0;
    private readonly files: ApplicationFiles;
    private readonly configuration: ApplicationConfiguration;
    private readonly listeners = new Set<(event: ApplicationEvent) => void>();
    private readonly releases: Array<() => void> = [];
    private readonly contexts = new Map<string, Promise<ConversationClient>>();
    private readonly pending = new Set<Promise<unknown>>();
    private closing?: Promise<void>;
    constructor(private readonly runtime: ApplicationRuntime, private readonly workspaces: readonly string[]) {
        this.configuration = new ApplicationConfiguration(runtime.agentService, () => runtime.llmDriver.init());
        this.releases.push(runtime.llmDriver.onChange(() => this.configurationChanged()));
        this.releases.push(runtime.agentService.onChange(() => this.configurationChanged()));
        this.files = new ApplicationFiles({ workspaces, projects: runtime.projects,
            openWorkspace: name => runtime.vfs.openFileSystem(workspaceRoot(name)) }, () => this.publish({ kind: 'invalidate', scope: 'files' }));
        this.releases.push(runtime.sessionRepository.subscribe(() => this.publish({ kind: 'invalidate', scope: 'sessions' })));
    }
    private configurationChanged(): void {
        if (this.closed || this.configurationEventQueued) return;
        this.configurationEventQueued = true;
        queueMicrotask(() => {
            this.configurationEventQueued = false;
            if (!this.closed) this.publish({ kind: 'invalidate', scope: 'configuration' });
        });
    }
    private publish(change: ApplicationChange): void {
        const event: ApplicationEvent = { ...change, revision: ++this.revision };
        for (const listener of this.listeners) {
            try { listener(copyData(event)); } catch (error) { console.warn('[Application] Event listener failed', error); }
        }
    }
    private context(sessionId: string): Promise<ConversationClient> {
        let context = this.contexts.get(sessionId);
        if (!context) {
            context = this.runtime.openConversation(sessionId).then(client => {
                this.releases.push(client.sessionManager.onEvent(event => this.publish({ kind: 'session', sessionId, event })),
                    client.sessionManager.onGlobalEvent(event => this.publish({ kind: 'registry', event })));
                return client;
            });
            this.contexts.set(sessionId, context);
            void context.catch(() => { if (this.contexts.get(sessionId) === context) this.contexts.delete(sessionId); });
        }
        return context;
    }
    private track<T>(work: Promise<T>): Promise<T> {
        this.pending.add(work);
        void work.finally(() => this.pending.delete(work)).catch(() => {});
        return work;
    }
    private assertOpen(): void { if (this.closed) throw new FSError('EIO', 'Application client is closed'); }
    subscribe(listener: (event: ApplicationEvent) => void): () => void {
        this.assertOpen(); this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
    async query<K extends keyof ApplicationQueries>(name: K, input: ApplicationQueries[K]['input'], signal?: AbortSignal): Promise<ApplicationQueries[K]['output']> {
        this.assertOpen(); signal?.throwIfAborted(); validateApplicationQuery(name, input);
        return this.track(this.read(name, input).then(copyData)) as Promise<ApplicationQueries[K]['output']>;
    }
    private async read(name: keyof ApplicationQueries, input: ApplicationQueries[keyof ApplicationQueries]['input']): Promise<unknown> {
        switch (name) {
            case 'configuration': return this.configuration.invoke(input as ApplicationQueries['configuration']['input']);
            case 'capabilities': return { protocol: APPLICATION_PROTOCOL_VERSION, workspaces: [...this.workspaces], commands: [...safeCommands], events: true, receipts: false };
            case 'entry': {
                const query = input as ApplicationQueries['entry']['input'];
                return this.files.use(query.workspace, query.path, (fs, path) => fs.driver.getNode(path));
            }
            case 'session': return this.session((input as ApplicationQueries['session']['input']).sessionId);
            case 'directory': return this.files.directory(input as ApplicationQueries['directory']['input']);
            case 'file': return readApplicationFile(this.files, input as ApplicationQueries['file']['input']);
            case 'navigation': return this.navigation((input as ApplicationQueries['navigation']['input']).folder);
            case 'sessions': {
                const query = input as ApplicationQueries['sessions']['input'];
                return query.folder === undefined ? this.runtime.sessionRepository.listSummaries()
                    : this.runtime.sessionRepository.listSummariesInFolder(query.folder);
            }
            case 'conversation': return this.conversation(input as ApplicationQueries['conversation']['input']);
            default: throw new FSError('ECAPABILITY', 'Unknown application query');
        }
    }
    private async session(id: string) {
        const { title, summary, origin, createdAt, updatedAt, folder, parentSessionId } = await this.runtime.sessionRepository.getManifest(id);
        return { id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId };
    }
    private async navigation(folder: string | null) {
        const known = await this.runtime.sessionRepository.listFolders();
        const folders = await this.runtime.projects.navigationFolders(known);
        const sessions = await this.runtime.sessionRepository.listSummariesInFolder(folder);
        return { folders: folders.filter(item => item.parentPath === folder).map(item => ({ path: item.path, name: item.name,
            parentPath: item.parentPath, ...(item.project ? { projectId: item.project.id } : {}) })), sessions };
    }
    private async conversation(query: ApplicationQueries['conversation']['input']) {
        const { sessionId, limit = 40 } = query;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new FSError('EINVAL', 'Invalid conversation page');
        const manifest = await this.runtime.sessionRepository.getManifest(sessionId), client = await this.context(sessionId);
        const writable = await this.runtime.prepareSession?.(sessionId) ?? true;
        const tasks = await this.runtime.kernel.kernel.listSessionPendingInteractionTasks(sessionId);
        const interactions = tasks.flatMap(task => Object.values(task.interactions).filter(request => request.status === 'pending')
            .map(request => ({ taskId: task.id, request })));
        const current = client.sessionManager.getSnapshot(), revision = this.revision;
        const end = query.before ? current.sessions.findIndex(group => group.id === query.before) : current.sessions.length;
        if (end < 0) throw new FSError('ECONFLICT', 'Conversation page changed');
        const start = Math.max(0, end - limit), snapshot = copyData({ ...current, sessions: current.sessions.slice(start, end) });
        return { manifest, snapshot, writable, revision, hasEarlier: start > 0, interactions };
    }
    async command<K extends keyof ApplicationCommands>(name: K, input: ApplicationCommands[K]['input'], signal?: AbortSignal): Promise<ApplicationCommands[K]['output']> {
        this.assertOpen(); signal?.throwIfAborted(); validateApplicationCommand(name, input);
        return this.track(this.write(name, input).then(copyData)) as Promise<ApplicationCommands[K]['output']>;
    }
    private async write(name: keyof ApplicationCommands, input: ApplicationCommands[keyof ApplicationCommands]['input']): Promise<unknown> {
        switch (name) {
            case 'configuration': {
                const request = input as ApplicationCommands['configuration']['input'];
                const result = await this.configuration.invoke(request);
                if (!request.operation.startsWith('test') && request.operation !== 'listProviderModels') this.configurationChanged();
                return result;
            }
            case 'createConversation': {
                const request = input as ApplicationCommands['createConversation']['input'];
                return { sessionId: await this.runtime.sessionRepository.createSession(request.title, request.folder) };
            }
            case 'respond': return this.respond(input as ApplicationCommands['respond']['input']);
            case 'cancelTask': return this.cancelTask(input as ApplicationCommands['cancelTask']['input']);
            case 'saveFile': {
                const result = await saveApplicationFile(this.files, input as ApplicationCommands['saveFile']['input']);
                this.publish({ kind: 'invalidate', scope: 'files' }); return result;
            }
            case 'conversation': return this.runConversation(input as ApplicationCommands['conversation']['input']);
            default: throw new FSError('ECAPABILITY', 'Unknown application command');
        }
    }
    private async runConversation(request: ApplicationCommands['conversation']['input']): Promise<unknown> {
        if (!safeCommands.has(request.name)) throw new FSError('ECAPABILITY', 'Conversation command is unavailable');
        if (request.args && typeof request.args === 'object' && !Array.isArray(request.args)
            && request.args.sessionId !== undefined && request.args.sessionId !== request.sessionId)
            throw new FSError('EACCES', 'Command must target the bound Session');
        const client = await this.context(request.sessionId);
        if (!readCommands.has(request.name) && this.runtime.prepareSession && !await this.runtime.prepareSession(request.sessionId))
            throw new FSError('EACCES', 'Session is owned by another host');
        return client.commandBus.execute(request.name, request.args);
    }
    private async respond(request: ApplicationCommands['respond']['input']): Promise<void> {
        if (this.runtime.prepareSession && !await this.runtime.prepareSession(request.sessionId)) throw new FSError('EACCES', 'Session is owned by another host');
        const handle = await this.runtime.kernel.kernel.openTask(request.taskId), { task } = await handle.status();
        const interaction = task.interactions[request.interactionId];
        if (task.sessionId !== request.sessionId || !interaction || interaction.status !== 'pending'
            || ['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new FSError('ECONFLICT', 'Interaction is no longer pending');
        await handle.respond({ interactionId: request.interactionId, value: request.value });
    }
    private async cancelTask(request: ApplicationCommands['cancelTask']['input']): Promise<void> {
        if (this.runtime.prepareSession && !await this.runtime.prepareSession(request.sessionId)) throw new FSError('EACCES', 'Session is owned by another host');
        const handle = await this.runtime.kernel.kernel.openTask(request.taskId), { task } = await handle.status();
        if (task.sessionId !== request.sessionId) throw new FSError('EACCES', 'Task belongs to another Session');
        await handle.cancel(); this.publish({ kind: 'invalidate', scope: 'sessions' });
    }
    close(): Promise<void> {
        if (!this.closing) {
            this.closed = true; this.listeners.clear();
            this.closing = (async () => {
                await Promise.allSettled(this.pending);
                this.releases.splice(0).forEach(release => release());
                await Promise.allSettled(this.contexts.values());
                this.contexts.clear(); this.files.close();
            })();
        }
        return this.closing;
    }
}

/** Keep local DTOs equivalent to their wire form and exclude runtime attachment objects. */
function copyData<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value, (key, item) => key === 'fileRef' ? undefined : item)) as T;
}
