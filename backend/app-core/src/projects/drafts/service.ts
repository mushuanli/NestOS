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
        private readonly projectIds: () => Promise<string[]>) {}
    async open(projectId: string, folder: string): Promise<ProjectDraftComposer> {
        await this.reconcile(projectId);
        const store = this.store(projectId), record = await store.load();
        let resumeOnly = record.state === 'submitting';
        return {
            initialData: record.data,
            attachments: { put: content => store.putAttachment(content), read: id => store.readAttachment(id) },
            save: data => store.saveData(data), clear: async () => { await store.reset(); resumeOnly = false; },
            prepare: async () => {
                const intent = await store.begin(formatDefaultFileTitle());
                await this.sessions.ensureSession(intent.sessionId!, intent.title!, 'tauri', folder);
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
        if (record.state !== 'submitting' || !record.sessionId || !record.submissionId) return;
        if (sessionId && record.sessionId !== sessionId || roundId && record.submissionId !== roundId) return;
        try {
            if (!await hasCommittedSubmission(this.sessions, record.sessionId, submissionOf(projectId, record)!)) return;
            const event = await draft.promote();
            if (event) for (const listener of this.listeners) {
                try { listener(event); } catch (error) { console.warn('Project draft notification failed', error); }
            }
        } catch (error) {
            if (!(error instanceof FSError) || !['ENOENT', 'ECONFLICT'].includes(error.code)) throw error;
        }
    }
}

function submissionOf(projectId: string, record: ProjectDraftRecord): SessionSubmission | undefined {
    return record.submissionId ? { id: record.submissionId, source: { kind: 'project-draft', ownerId: projectId, id: record.id } } : undefined;
}
