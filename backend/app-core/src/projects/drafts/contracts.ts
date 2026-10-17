import type { ProjectDraftPromotion } from '@itookit/app-contracts/services';
export type { ProjectDraftComposer, ProjectDraftPromotion } from '@itookit/app-contracts/services';

export interface ProjectDraftRecord {
    version: 1; id: string; state: 'draft' | 'submitting'; data: string;
    sessionId?: string; submissionId?: string; title?: string;
}
/** Transaction adapter used by project policy; no VFS types cross this port. */
export interface DraftStore {
    putAttachment(content: ArrayBuffer): Promise<string>;
    readAttachment(id: string): Promise<ArrayBuffer>;
    load(): Promise<ProjectDraftRecord>;
    saveData(data: string): Promise<void>;
    reset(): Promise<void>;
    begin(title: string): Promise<ProjectDraftRecord>;
    promote(): Promise<ProjectDraftPromotion | undefined>;
    wasPromoted(): Promise<boolean>;
}
