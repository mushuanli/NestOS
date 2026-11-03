import type {IndependentCallInput, SubmissionRequest} from '@itookit/llm-session/contracts';
import type {KanbanExternalReference, KanbanItem, KanbanBoard, KanbanService} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import type {publishedOperation, OperationObservation} from '../run/published-operation';
import type {sessionSubmission} from '../run/session-submission';
export type ReviewAction = 'build' | 'deploy' | 'accept' | 'analyze' | 'merge';
export interface ReviewSnapshot {version: string; sourceVersion: string; targetVersion: string; context: unknown}
export interface MergePlan {
    sourceVersion: string; targetVersion: string; summary: string;
    conflicts: Array<{id: string; path: string; reason: string; options: Array<{id: string; label: string; detail?: string}>}>;
}
export interface ReviewJob {
    id: string; boardId: string; itemId: string; action: ReviewAction; fingerprint: string; snapshot: ReviewSnapshot;
    phase: 'prepared' | 'submitting' | 'settled'; state: OperationObservation['state']; code?: string; sessionId?: string;
    input?: IndependentCallInput; request?: SubmissionRequest; result?: unknown; createdAt: number;
    command?: import('@itookit/kanban/contracts').KanbanCommand; acceptanceVersion?: string;
}
export interface ReviewSettings {revision: number; bindings: Partial<Record<ReviewAction, KanbanExternalReference>>; jobs: string[]; receipts: Record<string, string>}
export interface ReviewAdapter {
    supports?(board: KanbanBoard, item: KanbanItem): boolean;
    runningVersion?(): string | undefined;
    snapshot(board: KanbanBoard, item: KanbanItem): Promise<ReviewSnapshot>;
    prepareAnalysis(input: {id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot}): Promise<SubmissionRequest>;
    readAnalysis(job: ReviewJob): Promise<unknown | undefined>;
}
export interface ReviewOperationsOptions {
    report?(job: ReviewJob): Promise<void>;
    sessionResource?(sessionId: string): Promise<string | undefined>;
    service: KanbanService; journal: KanbanAutomationJournal;
    catalog(): Promise<import('@itookit/llm-session/contracts').RootTargetCatalog>;
    published: ReturnType<typeof publishedOperation>; submission: ReturnType<typeof sessionSubmission>; adapter: ReviewAdapter;
    log(event: {operationId: string; stage: string; result: 'success' | 'failure'; code?: string; durationMs: number}): void;
}
export const reviewKey = (board: string, item: string) => 'review-operations:' + JSON.stringify([board, item]);
export const jobKey = (id: string) => 'review-operation:' + id;
