import { FSError } from '@itookit/vfs-core';
import type { ISessionRepository } from '@itookit/llm-session';
import { formatDefaultFileTitle } from '@itookit/common';
import { type SessionSubmission } from '@itookit/llm-flow/contracts';
import { hasCommittedSubmission } from '@itookit/llm-session';
import type { ProjectDraftPromotion, ProjectDraftRecord, ProjectDraftComposer, DraftStore } from './contracts';

/** Reconcile from durable evidence; notifications never create successor drafts. */
export class ProjectDraftService {
    private readonly listeners = new Set<(event: ProjectDraftPromotion) => void>();
    constructor(private readonly store: (projectId: string) => DraftStore, private readonly sessions: Pick<ISessionRepository, 'ensureSession' | 'readDocument' | 'getManifest'>,
        private readonly projectIds: () => Promise<string[]>, private readonly assertLocal?: (projectId: string) => Promise<void>,
        private readonly remoteReceipt?: (projectId: string, record: ProjectDraftRecord) => Promise<ProjectDraftPromotion['remote'] | undefined>,
        private readonly initializeExecution?: (sessionId: string) => Promise<void>,
        private readonly assertResettable?: (projectId: string, record: ProjectDraftRecord) => Promise<void>) {}
    async open(projectId: string, folder: string): Promise<ProjectDraftComposer> {
        await this.reconcile(projectId);
        const store = this.store(projectId), record = await store.load();
        let identity = record.id;
        let resumeOnly = record.state === 'submitting';
        return {
            get id() {return identity;},
            initialData: record.data,
            refresh: async () => {
                await this.reconcile(projectId);
                return await store.wasPromoted() ? this.open(projectId, folder) : undefined;
            },
            attachments: { put: content => store.putAttachment(content), read: id => store.readAttachment(id) },
            save: data => store.saveData(data), clear: async () => {
                const current = await this.store(projectId).load();
                if (current.id !== identity) throw new FSError('ECONFLICT', 'Project draft identity changed');
                await this.assertResettable?.(projectId, current);
                await store.reset(); identity = (await store.load()).id; resumeOnly = false; return identity;
            },
            prepare: async () => {
                await this.assertLocal?.(projectId);
                const intent = await store.begin(formatDefaultFileTitle());
                await this.sessions.ensureSession(intent.sessionId!, intent.title!, 'tauri', folder, null, {agentId: draftAgent(intent.data)});
                await this.initializeExecution?.(intent.sessionId!);
                return { sessionId: intent.sessionId!, resumeOnly, submission: submissionOf(projectId, intent) };
            },
        };
    }
    async ensure(projectId: string): Promise<void> { await this.store(projectId).load(); }
    onPromoted(listener: (event: ProjectDraftPromotion) => void): () => void {
        this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
    async submissionForSession(projectId: string, sessionId: string) {
        await this.reconcile(projectId, sessionId);
        const record = await this.store(projectId).load();
        return record.state === 'submitting' && record.sessionId === sessionId && record.submissionId
            ? submissionOf(projectId, record) : undefined;
    }
    async submitted(event: { sessionId: string; roundId: string; submission?: SessionSubmission }): Promise<void> {
        if (event.submission?.source.kind !== 'project-draft' || event.submission.id !== event.roundId) return;
        await this.reconcile(event.submission.source.ownerId, event.sessionId, event.roundId);
    }
    async recover(sessionId?: string, roundId?: string): Promise<void> {
        for (const projectId of await this.projectIds()) await this.reconcile(projectId, sessionId, roundId);
    }
    async reconcile(projectId: string, sessionId?: string, roundId?: string): Promise<void> {
        const draft = this.store(projectId), record = await draft.load();
        const remote = await this.remoteReceipt?.(projectId, record);
        if (remote) {this.publish(await draft.promote(remote)); return;}
        if (record.remoteTarget || record.state !== 'submitting' || !record.sessionId || !record.submissionId) return;
        if (sessionId && record.sessionId !== sessionId || roundId && record.submissionId !== roundId) return;
        try {
            if (!await hasCommittedSubmission(this.sessions, record.sessionId, submissionOf(projectId, record)!)) return;
            const event = await draft.promote();
            this.publish(event);
        } catch (error) {
            if (!(error instanceof FSError) || !['ENOENT', 'ECONFLICT'].includes(error.code)) throw error;
        }
    }
    private publish(event?: ProjectDraftPromotion): void {
        if (event) for (const listener of this.listeners) {
            try {listener(event);} catch (error) {console.warn('Project draft notification failed', error);}
        }
    }
}

function submissionOf(projectId: string, record: ProjectDraftRecord): SessionSubmission | undefined {
    return record.submissionId ? { id: record.submissionId, source: { kind: 'project-draft', ownerId: projectId, id: record.id } } : undefined;
}
function draftAgent(data: string): string | undefined {
    try { const id: unknown = JSON.parse(data).config?.agentId; return typeof id === 'string' && !id.startsWith('remote:') ? id : undefined; }
    catch { return undefined; }
}
