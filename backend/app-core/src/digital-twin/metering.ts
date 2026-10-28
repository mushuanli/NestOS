import type {TwinRecordWrite} from './contracts';
import {TwinRecords, write} from './records';
import type {TwinAnalysisJob} from './domain';

export interface TwinMeterEntry {
    period: string; sessionId: string; planId: string;
    state: 'reserved' | 'pending' | 'settled'; reservedTokens: number; tokens: number;
    usageKind: 'reported' | 'estimated' | 'unknown'; createdAt: number;
}
interface Period {spentTokens: number; reservedTokens: number}
export const meterPeriod = (time = Date.now()) => new Date(time).toISOString().slice(0, 7);

/** Returned writes participate in the same CAS transaction as the job and cumulative budget. */
export async function reserveMeter(records: TwinRecords, id: string, job: TwinAnalysisJob, limit?: number | null): Promise<TwinRecordWrite[]> {
    const period = job.meterPeriod!;
    const current = await records.get<Period>('meter-period', period);
    const data = current?.data ?? {spentTokens: 0, reservedTokens: 0};
    if (limit !== undefined && limit !== null && tokenSum(data.spentTokens, data.reservedTokens, job.reservedTokens) > limit)
        throw new Error('TWIN_MONTHLY_BUDGET_EXHAUSTED');
    return [write('meter-period', period, {...data, reservedTokens: tokenSum(data.reservedTokens, job.reservedTokens)}, current?.revision ?? null),
        write('meter-entry', id, {period, sessionId: job.sessionId, planId: job.scanScope?.planId ?? '', state: 'reserved',
            reservedTokens: job.reservedTokens, tokens: 0, usageKind: 'unknown', createdAt: job.createdAt ?? Date.now()} satisfies TwinMeterEntry, null)];
}

export async function settleMeter(records: TwinRecords, id: string, job: TwinAnalysisJob, tokens?: number,
    usageKind: TwinMeterEntry['usageKind'] = 'reported'): Promise<TwinRecordWrite[]> {
    if (!job.meterPeriod) return []; // Legacy in-flight jobs retain their original accounting.
    const entry = await records.get<TwinMeterEntry>('meter-entry', id);
    if (!entry || entry.data.period !== job.meterPeriod || entry.data.sessionId !== job.sessionId) throw new Error('TWIN_METER_ENTRY_MISMATCH');
    if (entry.data.state === 'settled') {
        if (tokens !== undefined && entry.data.tokens !== tokens) throw new Error('TWIN_METER_SETTLEMENT_CONFLICT');
        return [];
    }
    if (tokens === undefined) return [write('meter-entry', id, {...entry.data, state: 'pending'}, entry.revision)];
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('TWIN_INVALID_USAGE');
    const period = await records.get<Period>('meter-period', job.meterPeriod);
    if (!period || period.data.reservedTokens < entry.data.reservedTokens) throw new Error('TWIN_METER_RESERVATION_MISMATCH');
    return [write('meter-period', job.meterPeriod, {spentTokens: tokenSum(period.data.spentTokens, tokens),
        reservedTokens: period.data.reservedTokens - entry.data.reservedTokens}, period.revision),
        write('meter-entry', id, {...entry.data, state: 'settled', reservedTokens: 0, tokens, usageKind}, entry.revision)];
}

export async function meterSnapshot(records: TwinRecords) {
    const id = meterPeriod(), period = await records.get<Period>('meter-period', id);
    return {period: {id, spentTokens: period?.data.spentTokens ?? 0, reservedTokens: period?.data.reservedTokens ?? 0},
        entries: (await records.list<TwinMeterEntry>('meter-entry')).map(row => ({id: row.id, ...row.data})).sort((a, b) => b.createdAt - a.createdAt)};
}

function tokenSum(...values: number[]): number {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(total)) throw new Error('TWIN_INVALID_USAGE');
    return total;
}
