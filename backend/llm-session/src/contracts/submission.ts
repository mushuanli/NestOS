import type {FlowCallSource, SessionSubmission, TargetSelection} from '@itookit/llm-flow/contracts';
import type {ChatAttachment} from './chat';
import type {ExecutionOverrides, HistoryPolicy, SessionOrigin} from '../core/types';

/** Host validates immutable content readiness without rewriting the caller's submission identity. */
export type CallAssetValidator = (sessionId: string, value: unknown) => Promise<void>;

/** One caller-owned request; definition snapshots, plans and execution identities are host-owned. */
export interface SubmissionRequest {
    /** Explicit message anchor for a host-prepared branch in this same Session. */
    branchFrom?: {branch: string; roundId: string; role: 'user' | 'assistant'; userIndex?: number};
    expectedSessionId?: string;
    expectedBranch?: string;
    target: TargetSelection;
    expectedTarget?: import('@itookit/llm-flow/contracts').TargetRef;
    source: FlowCallSource;
    /** Original editor text for history; arguments remain the sole executable input after form confirmation. */
    presentation?: {text: string};
    attachments?: Array<Omit<ChatAttachment, 'fileRef'>>;
    submission?: SessionSubmission;
    overrides?: ExecutionOverrides;
    origin?: SessionOrigin;
    historyPolicy?: HistoryPolicy;
}

/** Admission evidence is distinct from an executed or completed history message. */
export interface SubmissionReceipt {
    operationId: string;
    status: 'accepted' | 'unknown';
    evidence?: 'queue' | 'history' | 'kernel';
}

export interface RootCallTarget {
    target: import('@itookit/llm-flow/contracts').TargetRef;
    name: string;
    icon?: string;
    description?: string;
    input?: {flowId: string; revision: number; digest: string; parameters: import('@itookit/llm-flow/contracts').FlowParameter[]};
}
export interface RootTargetCatalog {
    entries: RootCallTarget[];
    issues: Array<{kind: 'agent' | 'flow'; id?: string; code: string}>;
}
