/** Native stop acknowledgement and resource cleanup are separate facts. */
export interface ConnectionCleanupEvidence {
    sessionId: string;
    taskId: string;
    effectId: string;
    ref: string;
    kind: 'not-started' | 'terminal';
}
export type ConnectionCancelResult =
    | {status: 'stopped'; cleanup: 'confirmed' | 'pending'; evidence: ConnectionCleanupEvidence}
    | {status: 'pending'; phase: 'execution' | 'cleanup'; code?: string}
    | {status: 'unknown'; code?: string};

export type ConnectionReconcileResult<T> =
    | {status: 'completed'; result: T}
    | {status: 'running'; handleRef: string}
    | {status: 'not-started'; evidence: ConnectionCleanupEvidence & {kind: 'not-started'}}
    | {status: 'unknown'; code?: string};

/** A retry needs proof that the fenced original execution cannot start later. */
export function assertConnectionNotStarted(evidence: ConnectionCleanupEvidence,
    owner: Pick<ConnectionCleanupEvidence, 'sessionId' | 'taskId' | 'effectId'>): void {
    if (validEvidence(evidence, owner) && evidence.kind === 'not-started') return;
    throw Object.assign(new Error('CONNECTION_NOT_STARTED_EVIDENCE_INVALID'), {code: 'CONNECTION_NOT_STARTED_EVIDENCE_INVALID'});
}

/** Only confirmed stopping and cleanup may become a successful Effect cancellation. */
export function assertConnectionCleanupConfirmed(value: unknown, owner: Pick<ConnectionCleanupEvidence, 'sessionId' | 'taskId' | 'effectId'>):
    asserts value is {status: 'stopped'; cleanup: 'confirmed'; evidence: ConnectionCleanupEvidence} {
    const result = asCancelResult(value);
    if (result?.status === 'stopped' && result.cleanup === 'confirmed') {
        if (validEvidence(result.evidence, owner)) return;
        throw Object.assign(new Error('CONNECTION_STOP_EVIDENCE_INVALID'), {code: 'CONNECTION_STOP_EVIDENCE_INVALID'});
    }
    const code = cancellationCode(result), nativeCode = safeNativeCode(result && 'code' in result ? result.code : undefined);
    throw Object.assign(new Error(code), {code, ...(nativeCode ? {nativeCode} : {})});
}

function asCancelResult(value: unknown): Partial<ConnectionCancelResult> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ConnectionCancelResult> : null;
}

function cancellationCode(result: Partial<ConnectionCancelResult> | null): string {
    if (result?.status === 'unknown') return 'CONNECTION_STOP_UNKNOWN';
    if (result?.status === 'stopped' && result.cleanup === 'pending') return 'CONNECTION_CLEANUP_PENDING';
    if (result?.status === 'pending') {
        if (result.phase === 'cleanup') return 'CONNECTION_CLEANUP_PENDING';
        if (result.phase === 'execution') return 'CONNECTION_STOP_PENDING';
    }
    return 'CONNECTION_CANCEL_RESULT_INVALID';
}
function safeNativeCode(value: unknown): string | undefined {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
}

function validEvidence(value: ConnectionCleanupEvidence | undefined, owner: Pick<ConnectionCleanupEvidence, 'sessionId' | 'taskId' | 'effectId'>): boolean {
    return !!value && !Array.isArray(value) && value.sessionId === owner.sessionId && value.taskId === owner.taskId && value.effectId === owner.effectId
        && validEvidenceRef(value.ref) && ['not-started', 'terminal'].includes(value.kind);
}
function validEvidenceRef(value: unknown): boolean {return typeof value === 'string' && value.length > 0 && value.length <= 4096;}
