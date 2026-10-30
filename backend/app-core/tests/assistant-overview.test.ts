import {expect, it, vi} from 'vitest';
import type {SessionActivity} from '@itookit/durable-kernel/contracts';
import {assistantOverview, sessionEvent} from '../src/assistant/overview';
const activity = (patch: Partial<SessionActivity> = {}): SessionActivity => ({sessionId: 'session', sessionStatus: 'open', revision: 1, asOfSequence: 1,
    counts: {running: 0, queued: 0, created: 0, waiting: 0, paused: 0, blocked: 0, succeeded: 0, failed: 0, cancelled: 0}, pending: {approval: 0, input: 0, cleanup: 0}, ...patch});
it('prioritizes actionable states and coalesces progress without creating fresh unread completion notices', () => {
    const pending = activity({pending: {approval: 2, input: 1, cleanup: 0}, latestExit: {status: 'failed', at: 10}});
    expect(sessionEvent('s', 'Session', 20, pending)).toMatchObject({id: 'session:s', kind: 'approval', revision: 'approval:2', requiresAction: true, priority: 0});
    expect(sessionEvent('s', 'Session', 30, {...pending, revision: 10})!.revision).toBe('approval:2');
    const completed = activity({latestExit: {status: 'succeeded', at: 10}});
    expect(sessionEvent('s', 'Session', 40, completed)).toMatchObject({kind: 'completion', at: 10, revision: 'succeeded:10', requiresAction: false});
    expect(sessionEvent('s', 'Session', 40, {...completed, counts: {...completed.counts, running: 1}})).toBeUndefined();
    expect(sessionEvent('s', 'Session', 40, activity({latestExit: {status: 'cancelled', at: 10}}))).toBeUndefined();
});
function services() {
    const listSummaries = vi.fn(async () => [{id: 's', title: 'Private session title'}]);
    const kernel = {listSessions: async function* () {yield {id: 's', updatedAt: 20}; yield {id: 'internal-child', updatedAt: 30};},
        sessionActivity: vi.fn(async () => activity({pending: {approval: 1, input: 0, cleanup: 0}})), openSession: vi.fn()};
    const summary = {workspace: {id: 'personal', name: 'Personal'}, plans: [{id: 'scanner', name: 'Scan'}],
        runs: [{id: 'run', planId: 'scanner', name: 'Scan', state: 'failed', at: 30}]};
    const twin = {activitySummary: vi.fn(async () => summary), workspaces: async () => [{id: 'personal'}], openWorkspace: async () => twin, snapshot: vi.fn()};
    return {kernel: {kernel}, sessionRepository: {listSummaries, list: vi.fn()}, digitalTwin: twin};
}
it('reads cold user-bound summaries, excludes internal tasks and returns links without starting work or reading evidence', async () => {
    const ports = services(), result = await assistantOverview(ports as never);
    expect(result.events.map(item => item.kind)).toEqual(['approval', 'scanFailure']);
    expect(result.scanners).toEqual([{id: 'scanner', name: 'Scan', workspaceId: 'personal', workspaceName: 'Personal'}]);
    expect(result.events[1].target.resourceId).toBe('/workspace/personal/runs/run');
    expect(ports.kernel.kernel.openSession).not.toHaveBeenCalled(); expect(ports.digitalTwin.snapshot).not.toHaveBeenCalled(); expect(ports.sessionRepository.list).not.toHaveBeenCalled();
    expect(ports.kernel.kernel.sessionActivity).toHaveBeenCalledTimes(1);
});
it('reports partial source failures without leaking titles or error bodies into diagnostics', async () => {
    const ports = services(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ports.kernel.kernel.sessionActivity.mockRejectedValueOnce(new Error('PRIVATE_TOKEN'));
    try {
        const result = await assistantOverview(ports as never);
        expect(result.unavailable).toEqual(['sessions']); expect(result.events.map(item => item.kind)).toEqual(['scanFailure']);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_TOKEN'); expect(JSON.stringify(warn.mock.calls)).not.toContain('Private session title');
    } finally {warn.mockRestore();}
});
