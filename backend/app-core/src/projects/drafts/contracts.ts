import type { ProjectDraftPromotion } from '@itookit/app-contracts/services';
export type { ProjectDraftComposer, ProjectDraftPromotion } from '@itookit/app-contracts/services';

export type RemoteDraftTarget = Omit<NonNullable<ProjectDraftPromotion['remote']>, 'nativeSessionId' | 'turnId'>;

export interface ProjectDraftRecord {
    version: 1; id: string; state: 'draft' | 'submitting'; data: string;
    sessionId?: string; submissionId?: string; title?: string;
    attachmentScopeId?: string;
    harnessConnectionId?: string;
    remoteTarget?: RemoteDraftTarget;
}
/** Transaction adapter used by project policy; no VFS types cross this port. */
export interface DraftStore {
    putAttachment(content: ArrayBuffer): Promise<string>;
    readAttachment(id: string): Promise<ArrayBuffer>;
    load(): Promise<ProjectDraftRecord>;
    saveData(data: string): Promise<void>;
    reset(): Promise<void>;
    moveTo?(projectId: string): Promise<void>;
    begin(title: string, remoteTarget?: RemoteDraftTarget, harnessConnectionId?: string): Promise<ProjectDraftRecord>;
    promote(remote?: ProjectDraftPromotion['remote']): Promise<ProjectDraftPromotion | undefined>;
    wasPromoted(): Promise<boolean>;
}
