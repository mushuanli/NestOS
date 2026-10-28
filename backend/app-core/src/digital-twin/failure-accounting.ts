import {settleMeter} from './metering';
import { randomUUID } from '@itookit/common';
import { diagnosticDetail, TwinDiagnosticError } from './diagnostics';
import type { TwinAnalysisJob, TwinSettings } from './domain';
import type { TwinScanRun } from './scan-domain';
import { TwinRecords, write, type TwinDataRecord } from './records';

/** Cost settlement does not publish knowledge and remains valid after cancellation or lease transfer. */
export async function settleFailedJob(records: TwinRecords, id: string, error: unknown, code: string): Promise<void> {
    const job = await records.get<TwinAnalysisJob>('job', id);
    if (!job || job.data.state === 'committed') return;
    const tokens = error instanceof TwinDiagnosticError ? error.tokens : undefined;
    const data: TwinAnalysisJob = { ...job.data, state: job.data.state === 'cancelled' ? 'cancelled' : 'failed',
        finishedAt: job.data.finishedAt ?? Date.now(), error: code, errorDetail: diagnosticDetail(error),
        ...(tokens !== undefined ? { reservedTokens: 0, actualTokens: tokens } : {}) };
    const writes = [write('job', id, data, job.revision), ...await settleMeter(records, id, job.data, tokens)];
    if (tokens !== undefined && job.data.reservedTokens > 0) writes.push(...await accountingWrites(records, job, tokens));
    await records.store.commit({ operationId: randomUUID(), expectedForgetEpoch: (await records.store.inspect()).forgetEpoch, writes });
}
async function accountingWrites(records: TwinRecords, job: TwinDataRecord<TwinAnalysisJob>, tokens: number) {
    const settings = (await records.get<TwinSettings>('settings', 'pot'))!;
    const writes = [write('settings', settings.id, { ...settings.data,
        reservedTokens: settings.data.reservedTokens - job.data.reservedTokens,
        spentTokens: settings.data.spentTokens + tokens }, settings.revision)];
    if (job.data.scanScope) {
        const run = await records.get<TwinScanRun>('scan-run', job.data.scanScope.runId);
        if (run) writes.push(write('scan-run', run.id, { ...run.data,
            reservedTokens: run.data.reservedTokens - job.data.reservedTokens,
            spentTokens: run.data.spentTokens + tokens }, run.revision));
    }
    return writes;
}
