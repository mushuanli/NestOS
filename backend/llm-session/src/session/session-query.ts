// @file: llm-session/src/session/session-query.ts
// SessionManager 的只读查询面（ISP）：把「查询」从「命令」中分离，
// 供 UI/消费者只依赖窄的只读接口，避免拿到整个上帝门面。

import type { SessionGroup, SessionStatus, SessionRuntime, SessionSnapshot } from '../core/types';
import type { BranchTreeNode } from '../persistence/types';

export interface SessionQuery {
    readonly id: string;
    getSnapshot(): SessionSnapshot;
    getSessions(): SessionGroup[];
    getCurrentSessionId(): string | null;
    getStatus(): SessionStatus | 'unbound';
    isGenerating(): boolean;
    getAllSessions(): SessionRuntime[];
    getSessionRuntime(sessionId: string): SessionRuntime | undefined;
    hasUnsavedChanges(): boolean;
    canRegenerate(messageId: string): { allowed: boolean; reason?: string };
    canDeleteMessage(messageId: string): { allowed: boolean; reason?: string };
    canEdit(messageId: string): { allowed: boolean; reason?: string };
    getSiblings(messageId: string): Promise<SessionGroup[]>;
    getBranchTree(): Promise<BranchTreeNode>;
}
