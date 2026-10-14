import { expect, it } from 'vitest';
import { analysisHTML, analysisProgress, analysisStatusHTML, type SourceInfo } from '../src/digital-twin/source-results';

function info(state?: string, overrides: Record<string, unknown> = {}): SourceInfo {
    return {
        included: true, ignored: false, settings: { data: { connectionId: 'model', paused: false } },
        worker: { error: '' }, sources: [], memories: [], jobs: [], discoveryErrors: [], nextScanAt: 0,
        plan: { id: 'selected', revision: 'new' },
        runs: state ? [{ data: { planId: 'selected', planRevision: 'new', createdAt: 2, state, error: 'failure detail' } }] : [],
        ...overrides,
    } as unknown as SourceInfo;
}
it('distinguishes waiting, running, empty completion and failures', () => {
    expect(analysisProgress(info()).key).toBe('analysisWaiting');
    expect(analysisProgress(info('queued')).key).toBe('analysisWaiting');
    expect(analysisProgress(info('running')).key).toBe('analysisRunning');
    expect(analysisProgress(info('succeeded')).key).toBe('analysisNoResults');
    expect(analysisProgress(info('succeeded', { memories: [{}] })).key).toBe('analysisComplete');
    expect(analysisProgress(info('failed'))).toEqual({ key: 'analysisFailed', detail: 'failure detail' });
    expect(analysisProgress(info('cancelled')).key).toBe('scanState.cancelled');
});

it('separates the latest request from older failures and shows live elapsed time and results', () => {
    const running = info('running', { runs: [{ id: 'current', data: { planId: 'selected', planRevision: 'new',
        createdAt: 1000, startedAt: 2000, state: 'running', sourceIds: ['source'], completedSourceIds: [] } }],
        jobs: [{ data: { scanScope: { runId: 'current' }, requestStartedAt: 2500, addedMemories: 2 } }], nextScanAt: 90000 });
    const html = analysisStatusHTML(running, 62000);
    expect(html).toContain('已运行: 60');
    expect(html).toContain('本次新增结果: 2');
    expect(html).toContain('尚未收到完整非流式响应');
    expect(html).toContain('下次自动更新');
    const waiting = analysisStatusHTML(info('failed', { plan: { id: 'selected', revision: 'newer', data: { updatedAt: 1000 } } }), 3000);
    expect(waiting).toContain('等待扫描');
    expect(waiting).toContain('上次扫描: 失败');
});

it('offers all saved history beyond the initial display window', () => {
    const jobs = Array.from({ length: 25 }, (_, index) => ({ id: `job-${index}`, data: { createdAt: index + 1,
        state: 'failed', offset: 0, end: 1, taskId: `task-${index}`, reservedTokens: 0, error: '' } }));
    const selected = info(undefined, { jobs });
    const initial = analysisHTML(selected);
    expect(initial).toContain('25 个提取任务');
    expect(initial).toContain('data-show-history');
    expect(initial).not.toContain('<code>task-0</code>');
    const all = analysisHTML(selected, Infinity);
    expect(all).toContain('<code>task-0</code>');
    expect(all).not.toContain('data-show-history');
});
it('shows blocking configuration and ignores failures from a previous plan revision', () => {
    expect(analysisProgress(info('queued', { settings: { data: { connectionId: '' } } })).key).toBe('connectionRequired');
    expect(analysisProgress(info('queued', { settings: { data: { connectionId: 'model', paused: true } } })).key).toBe('paused');
    expect(analysisProgress(info('running', { ignored: true })).key).toBe('selectionRemoved');
    expect(analysisProgress(info('failed', { plan: { id: 'selected', revision: 'newer' } })).key).toBe('analysisWaiting');
    expect(analysisProgress(info('succeeded', { sources: [{ data: { status: 'inaccessible' } }] })).key).toBe('analysisUnavailable');
});

it('separates model failure from uncertain usage and displays the saved cause', () => {
    const html = analysisHTML(info('failed', { jobs: [{ data: { state: 'failed', offset: 0, end: 1873,
        reservedTokens: 9000, error: 'TWIN_EXTRACTION_FAILED', errorDetail: 'HTTP_400: Unsupported response_format <script>' } }] }));
    expect(html).toContain('HTTP_400: Unsupported response_format &lt;script&gt;');
    expect(html).not.toContain('失败 / 用量待结算');
    expect(html).toContain('9000 token');
    const settled = analysisHTML(info('failed', { jobs: [{ data: { state: 'failed', offset: 0, end: 1873,
        reservedTokens: 0, error: 'TWIN_INVALID_EXTRACTION' } }] }));
    expect(settled).not.toContain('0 token');
});

it('shows operation timestamps, duration and explicitly marks historical missing diagnostics', () => {
    const createdAt = Date.UTC(2026, 9, 10, 10, 0, 0);
    const html = analysisHTML(info('failed', { jobs: [{ id: 'job-id', data: { state: 'failed', offset: 0, end: 1873,
        createdAt, startedAt: createdAt + 1000, finishedAt: createdAt + 4500, taskId: 'task-id',
        reservedTokens: 1, error: 'TWIN_EXTRACTION_FAILED', connectionId: 'selected-model' } }] }));
    expect(html).toContain('2026-10-10T10:00:00.000Z');
    expect(html).toContain('3.5');
    expect(html).toContain('selected-model');
    expect(html).toContain('task-id');
    expect(html).toContain('没有保存具体失败原因');
});

it('uses only the associated scan time for historical jobs and displays settled failure usage', () => {
    const createdAt = Date.UTC(2026, 9, 10, 10, 0, 0);
    const html = analysisHTML(info('failed', {
        jobs: [{ id: 'historical-job', data: { state: 'failed', offset: 0, end: 1873, reservedTokens: 0,
            actualTokens: 1234, error: 'TWIN_EXTRACTION_TRUNCATED', scanScope: { runId: 'matching-run' } } }],
        runs: [{ id: 'unrelated-run', data: { createdAt: createdAt + 9999 } },
            { id: 'matching-run', data: { createdAt, startedAt: createdAt + 1000, finishedAt: createdAt + 4500 } }],
    }));
    expect(html).toContain('关联扫描时间');
    expect(html).toContain('2026-10-10T10:00:00.000Z');
    expect(html).not.toContain('2026-10-10T10:00:09.999Z');
    expect(html).not.toContain('历史记录未保存操作时间');
    expect(html).toContain('已结算消耗');
    expect(html).not.toContain('实际用量未知');
});
