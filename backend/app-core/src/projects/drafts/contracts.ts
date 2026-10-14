export interface ProjectDraftRecord {
    version: 1; id: string; state: 'draft' | 'submitting'; data: string;
    sessionId?: string; submissionId?: string; title?: string;
}
export interface ProjectDraftPromotion {
    type: 'project.draftPromoted'; projectId: string; draftId: string;
    sessionId: string; submissionId: string; nextDraftId: string; state: 'promoted';
}

export interface ProjectDraftComposer {
    readonly attachments: {
        put(content: ArrayBuffer): Promise<string>;
        read(id: string): Promise<ArrayBuffer>;
    };
    readonly initialData: string;
    save(data: string): Promise<void>;
    clear(): Promise<void>;
    prepare(): Promise<{ sessionId: string; resumeOnly: boolean; submission?: import('@itookit/llm-flow/contracts').SessionSubmission }>;
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
}
