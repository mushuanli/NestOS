import type {TwinAnalysisJob} from './domain';
import type {TwinRecords} from './records';
import {retry} from './scan-store';
import type {KernelAdaptersRuntimeOptions} from '@itookit/kernel-adapters';

type Request = Parameters<NonNullable<KernelAdaptersRuntimeOptions['authorizeLlm']>>[0];
type Context = Parameters<NonNullable<KernelAdaptersRuntimeOptions['authorizeLlm']>>[1];
const bindingKey = (sessionId: string) => 'scanner-session:' + sessionId;
export async function scannerJob(records: TwinRecords, sessionId: string) {
    if (sessionId.startsWith('twin-analysis-')) {
        const job = await records.get<TwinAnalysisJob>('job', sessionId.slice('twin-analysis-'.length));
        return job?.data.executor ? job : null;
    }
    const bound = await records.get<{jobId: string}>('checkpoint', bindingKey(sessionId));
    return bound ? records.get<TwinAnalysisJob>('job', bound.data.jobId) : null;
}
export async function bindScannerSession(records: TwinRecords, job: TwinAnalysisJob, sessionId: string): Promise<void> {
    const jobId = job.sessionId.slice('twin-analysis-'.length);
    const actual = await records.get<TwinAnalysisJob>('job', jobId);
    if (!actual?.data.executor || actual.data.sessionId !== job.sessionId || !['queued', 'running'].includes(actual.data.state)) throw new Error('TWIN_SCANNER_JOB_STALE');
    const previous = await records.get<{jobId: string}>('checkpoint', bindingKey(sessionId));
    if (previous) {
        if (previous.data.jobId !== jobId) throw new Error('TWIN_SCANNER_BINDING_CONFLICT');
        return;
    }
    await records.save('checkpoint', bindingKey(sessionId), {jobId}, null);
}

/** Each actual provider attempt consumes part of the prepaid job envelope before sending. */
export async function authorizeScannerExchange(records: TwinRecords, job: TwinAnalysisJob, request: Request, context: Context): Promise<void> {
    if (!context.attemptId) throw new Error('TWIN_SCANNER_ATTEMPT_REQUIRED');
    const output = request.request.maxTokens ?? 8192;
    if (!Number.isSafeInteger(output) || output <= 0 || output > job.reservedTokens) throw new Error('TWIN_SCAN_BUDGET_EXHAUSTED');
    request.request.maxTokens = output;
    const quantity = new TextEncoder().encode(JSON.stringify(request.request)).byteLength + output + 1024;
    const key = 'scanner-envelope:' + job.sessionId;
    await retry(async () => {
        const previous = await records.get<{used: number; attempts: string[]}>('checkpoint', key);
        if (previous?.data.attempts.includes(context.attemptId!)) return;
        const used = (previous?.data.used ?? 0) + quantity;
        if (!Number.isSafeInteger(used) || used > job.reservedTokens) throw new Error('TWIN_SCAN_BUDGET_EXHAUSTED');
        await records.save('checkpoint', key, {used, attempts: [...previous?.data.attempts ?? [], context.attemptId]}, previous?.revision ?? null);
    });
}
