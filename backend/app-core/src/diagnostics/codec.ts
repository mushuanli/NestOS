import {FSError} from '@itookit/vfs-core';
import type {DiagnosticEvent, DiagnosticSeries} from '@itookit/app-contracts/services';
import {initial} from './series';
const identity = /^[a-zA-Z0-9_.:-]{1,200}$/;
const label = /^[a-zA-Z0-9_.:-]{1,100}$/;
const fields = ['code', 'reason', 'projectId', 'connectionId', 'mountId', 'profileId', 'sessionId', 'requestId'] as const;

/** Rebuild records so persisted or provider-owned extra fields cannot enter the public log. */
export function clean(value: unknown): DiagnosticEvent {
    const v = value as DiagnosticEvent;
    if (!v || typeof v.id !== 'string' || !identity.test(v.id) || typeof v.operationId !== 'string' || !identity.test(v.operationId) || !Number.isFinite(v.timestamp)
        || !['mcp', 'cells', 'application'].includes(v.module) || typeof v.operation !== 'string' || !label.test(v.operation) || typeof v.stage !== 'string' || !label.test(v.stage)
        || !['started', 'success', 'failure', 'cancelled'].includes(v.result) || !['info', 'warn', 'error'].includes(v.level))
        throw new FSError('EINVAL', 'Invalid diagnostic event');
    const event: DiagnosticEvent = {id: v.id, timestamp: v.timestamp, operationId: v.operationId, module: v.module,
        operation: v.operation, stage: v.stage, result: v.result, level: v.level};
    if (typeof v.startedAt === 'number' && Number.isFinite(v.startedAt) && v.startedAt >= 0 && v.startedAt <= v.timestamp) event.startedAt = v.startedAt;
    for (const key of fields) if (typeof v[key] === 'string' && identity.test(v[key]!)) event[key] = v[key];
    if (Array.isArray(v.causeCodes)) event.causeCodes = v.causeCodes.filter(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)).slice(0, 8);
    if (typeof v.rpcCode === 'number' && Number.isSafeInteger(v.rpcCode)) event.rpcCode = v.rpcCode;
    if (typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)) event.durationMs = Math.max(0, Math.round(v.durationMs));
    if (v.series) event.series = cleanSeries(v.series, event);
    return event;
}

function cleanSeries(value: DiagnosticSeries, event: DiagnosticEvent): DiagnosticSeries {
    if (!Number.isSafeInteger(value.count) || value.count < 1 || !Number.isFinite(value.firstAt) || !Number.isFinite(value.lastAt)
        || value.firstAt < 0 || value.firstAt > value.lastAt || value.lastAt !== event.timestamp || typeof value.firstOperationId !== 'string' || !identity.test(value.firstOperationId)
        || value.endedAt !== undefined && (!Number.isFinite(value.endedAt) || value.endedAt < value.lastAt)) throw new FSError('EINVAL', 'Invalid diagnostic series');
    const series = {...initial(event), count: value.count, firstAt: value.firstAt, lastAt: value.lastAt, firstOperationId: value.firstOperationId};
    if (typeof value.firstRequestId === 'string' && identity.test(value.firstRequestId)) series.firstRequestId = value.firstRequestId;
    if (value.endedAt !== undefined) series.endedAt = value.endedAt;
    if (['recovered', 'changed', 'restarted'].includes(value.ending ?? '')) series.ending = value.ending;
    series.samples = Array.isArray(value.samples) ? value.samples.slice(-5).flatMap(item => {
        if (!item || !Number.isFinite(item.timestamp) || item.timestamp < value.firstAt || item.timestamp > value.lastAt
            || typeof item.operationId !== 'string' || !identity.test(item.operationId)) return [];
        return [{timestamp: item.timestamp, operationId: item.operationId,
            ...(typeof item.requestId === 'string' && identity.test(item.requestId) ? {requestId: item.requestId} : {}),
            ...(Number.isFinite(item.durationMs) && item.durationMs! >= 0 ? {durationMs: item.durationMs} : {})}];
    }) : [];
    for (const key of ['minDurationMs', 'maxDurationMs', 'totalDurationMs'] as const)
        if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key]! >= 0) series[key] = value[key];
    return series;
}
