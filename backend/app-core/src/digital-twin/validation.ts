import {scannerExecutor} from '@itookit/app-contracts';
import { userIdentity } from './identity';
import { ruleLines, scanRules } from './scan-rules';
import type { TwinRecordFamily } from './contracts';
import { TWIN_KINDS } from './domain';
import { scanInput, identifiers, type TwinScanPlanInput } from './scan-domain';

type Data = Record<string, unknown>;
const validators: Partial<Record<TwinRecordFamily, (data: Data) => void>> = {
    memory: validateMemory, source: validateSource, settings: validateSettings,
    grant: data => { strings(data, ['sessionId', 'agentId', 'connectionId', 'connectionFingerprint', 'project']); booleans(data, ['enabled']); },
    job: validateJob,
    'scan-plan': data => { scanInput(data as unknown as TwinScanPlanInput); strings(data, ['connectionFingerprint']); integers(data, ['createdAt', 'updatedAt']); },
    'scan-run': validateScanRun,
    'scan-checkpoint': data => { strings(data, ['sourceId', 'sourceHash', 'incarnation']); integers(data, ['offset']); booleans(data, ['complete']); },
    usage: validateUsage,
    'meter-period': data => integers(data, ['spentTokens', 'reservedTokens']),
    'meter-entry': data => {
        strings(data, ['period', 'sessionId', 'planId']);
        integers(data, ['tokens', 'reservedTokens', 'createdAt']);
        oneOf(data.state, ['reserved', 'pending', 'settled']);
        oneOf(data.usageKind, ['reported', 'estimated', 'unknown']);
    },
};
/** Reject malformed persisted authority and content rather than granting through truthy defaults. */
export function validateData(family: TwinRecordFamily, data: Data): void { validators[family]?.(data); }
function validateMemory(data: Data): void {
    if (data.scanRunId !== undefined) strings(data, ['scanRunId']);
    if (data.originSourceId !== undefined) strings(data, ['originSourceId']);
    strings(data, ['content', 'subject', 'subjectId', 'project', 'eventTime', 'sourceId', 'sourceHash', 'sourceIncarnation', 'quote', 'successCondition', 'deadline']);
    oneOf(data.kind, TWIN_KINDS); oneOf(data.state, ['candidate', 'active', 'rejected', 'disputed']);
    oneOf(data.goalStatus, ['draft', 'active', 'paused', 'completed', 'cancelled']);
    booleans(data, ['independent']); integers(data, ['recordedAt']);
    if (!Array.isArray(data.executionRefs) || data.executionRefs.some(ref => !ref || typeof ref.sessionId !== 'string' || typeof ref.taskId !== 'string')) invalid();
    if (!Array.isArray(data.evidenceIds) || data.evidenceIds.some(id => typeof id !== 'string')) invalid();
}
function validateSource(data: Data): void {
    strings(data, ['target', 'label', 'connectionId', 'connectionFingerprint', 'incarnation', 'nativeIdentity', 'hash', 'analyzedHash']);
    oneOf(data.kind, ['file', 'session', 'harness-session']); oneOf(data.status, ['available', 'changed', 'deleted', 'inaccessible']);
    booleans(data, ['enabled']); integers(data, ['offset', 'characters', 'checkedAt']);
    if (data.managed !== undefined) validateManagedSource(data);
}
function validateSettings(data: Data): void {
    if (data.monthlyTokenLimit !== undefined && data.monthlyTokenLimit !== null) integers(data, ['monthlyTokenLimit']);
    if (data.budgetUnlimited !== undefined) booleans(data, ['budgetUnlimited']);
    userIdentity(data);
    if (data.connectionId !== undefined && typeof data.connectionId !== 'string') invalid();
    if (data.globalExclude !== undefined) ruleLines(data.globalExclude);
    booleans(data, ['paused', 'useEnabled']); integers(data, ['tokenLimit', 'reservedTokens', 'spentTokens']);
}
function validateJob(data: Data): void {
    scannerExecutor(data.executor as import('@itookit/app-contracts').TwinScannerExecutor | undefined);
    if (data.meterPeriod !== undefined && (typeof data.meterPeriod !== 'string' || !/^\d{4}-\d{2}$/.test(data.meterPeriod))) invalid();
    for (const key of ['createdAt', 'startedAt', 'finishedAt', 'actualTokens', 'requestStartedAt', 'responseReceivedAt', 'responseCompletedAt']) if (data[key] !== undefined) integers(data, [key]);
    if (data.errorDetail !== undefined) strings(data, ['errorDetail']);
    userIdentity(data);
    strings(data, ['sourceId', 'sourceRevision', 'sourceHash', 'connectionId', 'sessionId', 'taskId', 'error']);
    integers(data, ['offset', 'end', 'epoch', 'reservedTokens']);
    if (data.start !== undefined) { integers(data, ['start']); if (data.start !== data.offset) invalid(); }
    oneOf(data.state, ['queued', 'running', 'committed', 'failed', 'cancelled']);
}
function validateUsage(data: Data): void {
    strings(data, ['sessionId', 'taskId', 'agentId', 'connectionId', 'grantRevision']); integers(data, ['usedAt']);
    if (!Array.isArray(data.memoryRefs) || !data.memoryRefs.length || data.memoryRefs.some(ref => !ref
        || typeof ref.id !== 'string' || typeof ref.revision !== 'string')) invalid();
}
function validateScanRun(data: Data): void {
    scannerExecutor(data.executor as import('@itookit/app-contracts').TwinScannerExecutor | undefined);
    if (data.runTokenLimit !== undefined) integers(data, ['runTokenLimit']);
    if (data.budgetUnlimited !== undefined) booleans(data, ['budgetUnlimited']);
    if (data.errorDetail !== undefined) strings(data, ['errorDetail']);
    if (data.rules !== undefined) scanRules(data.rules);
    if (data.autoConfirm !== undefined && typeof data.autoConfirm !== 'boolean') invalid();
    strings(data, ['planId', 'planRevision', 'name', 'connectionId', 'connectionFingerprint', 'owner', 'error']);
    identifiers(data.sourceIds, 10000, true); identifiers(data.completedSourceIds, 10000, true);
    integers(data, ['tokenLimit', 'reservedTokens', 'spentTokens', 'createdAt', 'startedAt', 'finishedAt', 'fence']); booleans(data, ['singleBatch']);
    oneOf(data.state, ['queued', 'running', 'succeeded', 'paused', 'failed', 'cancelled', 'interrupted']);
    oneOf(data.trigger, ['manual', 'interval', 'changes']); oneOf(data.mode, ['analyze', 'reconcile']);
    if (!Array.isArray(data.kinds) || !data.kinds.length || data.kinds.some(kind => !TWIN_KINDS.includes(kind))) invalid();
}
function validateManagedSource(data: Data): void {
    booleans(data, ['managed']);
    const resource = data.resource as Data | undefined;
    if (data.managed && (!resource || typeof resource !== 'object' || Array.isArray(resource)
        || typeof resource.projectId !== 'string' || !resource.projectId || resource.kind !== data.kind || resource.target !== data.target)) invalid();
    if (resource?.location !== undefined) oneOf(resource.location, ['local', 'remote']);
    if (resource?.directoryPath !== undefined && typeof resource.directoryPath !== 'string') invalid();
    if (data.observedVersion !== undefined && typeof data.observedVersion !== 'string') invalid();
}
function strings(data: Data, keys: string[]): void { for (const key of keys) if (typeof data[key] !== 'string') invalid(); }
function booleans(data: Data, keys: string[]): void { for (const key of keys) if (typeof data[key] !== 'boolean') invalid(); }
function integers(data: Data, keys: string[]): void { for (const key of keys) if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) invalid(); }
function oneOf(value: unknown, allowed: readonly string[]): void { if (typeof value !== 'string' || !allowed.includes(value)) invalid(); }
function invalid(): never { throw new Error('TWIN_INVALID_PERSISTED_DATA'); }
