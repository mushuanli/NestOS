import {FSError, type IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {HarnessRecovery} from '@itookit/cells-driver';
import type {ProjectConversationPort} from '@itookit/app-contracts/services';
import {remoteConversationRecoveryPath} from './remote-conversation-store';
import {mapConcurrent} from '../utils/map-concurrent';

export interface RemoteConversationRecoveryTarget {
    projectId: string; connectionId: string; serverProjectId: string; principalId?: string;
    profileId: string; conversationId: string; sessionId: string;
}
export interface RemoteRecoveryDiagnostic {
    operationId: string; stage: string; result: 'success' | 'deferred'; durationMs: number;
    code?: string; projectId?: string; sessionId?: string; queueCount?: number;
}
export interface RemoteRecoveryOptions {
    include?(target: RemoteConversationRecoveryTarget): boolean;
    onDeferred?(target: RemoteConversationRecoveryTarget, error: unknown): void;
}
const log = createModuleLogger('remote-conversation-recovery');

/** Reattach host observers from this user's journal; never replay a persisted request. */
export async function recoverRemoteConversationQueues(fs: IFileSystem,
    open: (target: RemoteConversationRecoveryTarget) => Promise<ProjectConversationPort>,
    onDiagnostic?: (event: RemoteRecoveryDiagnostic) => void, options: RemoteRecoveryOptions = {}): Promise<{recovered: number; deferred: number}> {
    const targets: RemoteConversationRecoveryTarget[] = [], result = {recovered: 0, deferred: 0};
    if (!await fs.driver.exists(remoteConversationRecoveryPath)) return result;
    if (!fs.meta.seq) throw new FSError('ECAPABILITY', 'Remote recovery requires SeqFile operations');
    await fs.meta.seq.walkEntries(remoteConversationRecoveryPath, entry => {
        try {const target = recoveryTarget(entry.key, entry.value); if (target && options.include?.(target) !== false) targets.push(target);}
        catch (error) {result.deferred++; report('decode', Date.now(), randomUUID(), error, onDiagnostic);}
        return true;
    });
    const restored = await mapConcurrent(targets, 4, target => options.include?.(target) === false
        ? Promise.resolve({recovered: 0, deferred: 0}) : recoverTarget(target, open, onDiagnostic, options.onDeferred));
    for (const item of restored) {result.recovered += item.recovered; result.deferred += item.deferred;}
    return result;
}

async function recoverTarget(target: RemoteConversationRecoveryTarget,
    open: (target: RemoteConversationRecoveryTarget) => Promise<ProjectConversationPort>,
    diagnostic?: (event: RemoteRecoveryDiagnostic) => void, deferred?: RemoteRecoveryOptions['onDeferred']) {
    const operationId = randomUUID(), started = Date.now(), result = {recovered: 0, deferred: 0};
    let source: ProjectConversationPort | undefined;
    try {
        source = await open(target); await source.read(); result.recovered++;
        emit({operationId, stage: 'observe', result: 'success', projectId: target.projectId,
            sessionId: target.sessionId, queueCount: source.snapshot().instructionQueue?.items.length ?? 0, durationMs: Date.now() - started}, diagnostic);
    } catch (error) {
        result.deferred++; report('observe', started, operationId, error, diagnostic, target); deferred?.(target, error);
    } finally {
        try {await source?.close();}
        catch (error) {result.deferred++; report('release-view', started, operationId, error, diagnostic, target);}
    }
    return result;
}

function recoveryTarget(key: string, value: string): RemoteConversationRecoveryTarget | undefined {
    const record = JSON.parse(value) as HarnessRecovery;
    const work = record.instructionQueue?.items.length || record.pending || record.responses?.length
        || record.controls?.some(item => item.receipt === 'pending' || item.receipt === 'accepted' && !item.terminal);
    if (!work) return;
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts) || ![5, 6].includes(parts.length) || parts.some(part => typeof part !== 'string' || !part || part.length > 1024)
        || typeof record.sessionId !== 'string' || !record.sessionId || record.sessionId.length > 1024)
        throw new FSError('EINVAL', 'Invalid remote queue recovery identity');
    const [projectId, connectionId, serverProjectId] = parts;
    return {projectId, connectionId, serverProjectId, ...(parts.length === 6 ? {principalId: parts[3]} : {}),
        profileId: parts[parts.length - 2], conversationId: parts[parts.length - 1], sessionId: record.sessionId};
}

function report(stage: string, started: number, operationId: string, error: unknown, onDiagnostic?: (event: RemoteRecoveryDiagnostic) => void, target?: RemoteConversationRecoveryTarget): void {
    const code = (error as {code?: unknown})?.code;
    emit({operationId, stage, result: 'deferred', ...(target ? {projectId: target.projectId, sessionId: target.sessionId} : {}),
        code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REMOTE_QUEUE_RECOVERY_FAILED', durationMs: Date.now() - started}, onDiagnostic);
}
function emit(event: RemoteRecoveryDiagnostic, onDiagnostic?: (event: RemoteRecoveryDiagnostic) => void): void {
    log[event.result === 'success' ? 'info' : 'warn']('remote.queue.recover', event);
    try {onDiagnostic?.(event);} catch {
        log.warn('remote.queue.recover', {operationId: event.operationId, stage: 'diagnostic', result: 'deferred', code: 'RECOVERY_DIAGNOSTIC_FAILED'});
    }
}
