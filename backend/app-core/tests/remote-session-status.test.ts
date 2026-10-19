import { afterEach, expect, it, vi } from 'vitest';
import { RemoteSessionStatus } from '../src/session/remote-session-status';
import type { HarnessStatusRow } from '@itookit/mindos-node-client';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
    vi.useFakeTimers();
    let identity: string | undefined = '[mcp,server,project,revision]';
    const observation: HarnessStatusRow['observation'] = {execution: 'running', rawStatus: 'active', owned: false,
        observedAt: 100, source: 'list', connection: 'online', stale: false, receiptUnknown: false, canInterrupt: false, canRespond: false, nativeError: false};
    const port = {poll: vi.fn(async () => [{profileId: 'p', sessionId: 's', observation}]), close: vi.fn(async () => {})};
    const open = vi.fn(async () => port);
    return {status: new RemoteSessionStatus(() => identity, open), port, open, change: (next?: string) => { identity = next; }};
}
it('shares one observer across subscribers and only notifies semantic changes', async () => {
    const {status, port, open} = fixture(), changed = vi.fn();
    const first = status.subscribe('project', changed), second = status.subscribe('project', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
    expect(status.get('project', 'p', 's')).toMatchObject({execution: 'running', canInterrupt: false});
    await vi.advanceTimersByTimeAsync(1000); expect(port.poll).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledOnce();
    first(); expect(port.close).not.toHaveBeenCalled(); second(); expect(port.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000); expect(port.poll).toHaveBeenCalledTimes(2);
});

it('keeps observation errors separate from connection state and backs off until recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {status, port} = fixture(); status.subscribe('project', vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    port.poll.mockRejectedValueOnce(new Error('Invalid projection'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(status.get('project', 'p', 's')).toMatchObject({connection: 'online', stale: true,
        refreshError: {stage: 'status', code: 'OBSERVATION_ERROR'}, canInterrupt: false, canRespond: false});
    await vi.advanceTimersByTimeAsync(1999); expect(port.poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(status.get('project', 'p', 's')).toMatchObject({connection: 'online', stale: false});
    expect(status.get('project', 'p', 's')?.refreshError).toBeUndefined(); await status.dispose();
});

it('backs off explicit refresh errors without requiring an offline state', async () => {
    const {status, port} = fixture(), [row] = await port.poll(); port.poll.mockClear();
    port.poll.mockResolvedValue([{...row, observation: {...row.observation, stale: true, refreshError: {stage: 'events', code: 'REQUEST_TIMEOUT'}}}]);
    status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1999); expect(port.poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(port.poll).toHaveBeenCalledTimes(2); await status.dispose();
});

it('isolates subscriber exceptions without losing connection state or other notifications', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const {status} = fixture(), changed = vi.fn();
    status.subscribe('project', () => { throw new Error('Rendering failed'); }); status.subscribe('project', changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledOnce(); expect(warn).toHaveBeenCalledWith('[Harness] Status subscriber failed');
    expect(status.get('project', 'p', 's')).toMatchObject({connection: 'online', stale: false}); await status.dispose();
});
it('invalidates changed grants before the next poll and closes the old observer', async () => {
    const {status, port, open, change} = fixture(); status.subscribe('project', vi.fn());
    await vi.advanceTimersByTimeAsync(0); change('new-revision');
    expect(status.get('project', 'p', 's')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000); expect(port.close).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledTimes(2);
    change(); await vi.advanceTimersByTimeAsync(1000); expect(status.get('project', 'p', 's')).toBeUndefined();
    await status.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('closes an observer that finishes opening after its subscriber leaves', async () => {
    const {port} = fixture(); let resolve!: (value: typeof port) => void;
    const status = new RemoteSessionStatus(() => 'identity', () => new Promise(done => { resolve = done; }));
    const stop = status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0); stop(); resolve(port);
    await vi.advanceTimersByTimeAsync(0); expect(port.close).toHaveBeenCalledOnce(); expect(port.poll).not.toHaveBeenCalled();
});

it('notifies directory versions independently of empty native session rows and fences revoked grants', async () => {
    const {status, port, change} = fixture(), changed = vi.fn(); let version = 'watch:1';
    port.poll.mockResolvedValue([]); Object.assign(port, {fileVersion: () => version}); status.subscribe('project', changed);
    await vi.advanceTimersByTimeAsync(0); expect(status.fileVersion('project')).toBe('watch:1');
    version = 'watch:2'; await status.refresh('project'); expect(changed).toHaveBeenCalledTimes(2);
    change(); expect(status.fileVersion('project')).toBeUndefined(); await status.dispose();
});
it('does not poll idle sessions and restarts only after an explicit refresh reports active work', async () => {
    const {status, port} = fixture(), [row] = await port.poll(); port.poll.mockClear();
    port.poll.mockResolvedValue([{...row, observation: {...row.observation, execution: 'idle'}}]);
    const stop = status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(port.poll).toHaveBeenCalledOnce();
    port.poll.mockResolvedValue([row]); await status.refresh('project');
    await vi.advanceTimersByTimeAsync(1000); expect(port.poll).toHaveBeenCalledTimes(3);
    port.poll.mockResolvedValue([{...row, observation: {...row.observation, execution: 'idle'}}]);
    await vi.advanceTimersByTimeAsync(1000); await vi.advanceTimersByTimeAsync(60_000);
    expect(port.poll).toHaveBeenCalledTimes(4); stop(); await status.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it('retains an activity refresh requested while the initial idle read is still pending', async () => {
    const {status, port} = fixture(), [row] = await port.poll(); port.poll.mockClear();
    let finish!: () => void;
    port.poll.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve([{...row, observation: {...row.observation, execution: 'idle'}}]);}));
    status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0);
    const refresh = status.refresh('project'); finish(); await refresh;
    await vi.advanceTimersByTimeAsync(1); expect(port.poll).toHaveBeenCalledTimes(2);
    await status.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it('serves a bounded stale projection on revisit without keeping an idle poll alive', async () => {
    const { status, port } = fixture();
    const stop = status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0); stop();
    expect(status.get('project', 'p', 's')).toMatchObject({ stale: true, canInterrupt: false, canRespond: false });
    await vi.advanceTimersByTimeAsync(5000); expect(port.poll).toHaveBeenCalledOnce();
    const again = status.subscribe('project', vi.fn());
    expect(status.get('project', 'p', 's')).toMatchObject({ stale: true });
    await vi.advanceTimersByTimeAsync(0); expect(port.poll).toHaveBeenCalledTimes(2);
    expect(status.get('project', 'p', 's')).toMatchObject({ stale: false });
    again(); await vi.advanceTimersByTimeAsync(30_001);
    expect(status.get('project', 'p', 's')).toBeUndefined(); await status.dispose();
});
it('does not reuse idle status after the configuration or grants change', async () => {
    const { status, change } = fixture();
    const stop = status.subscribe('project', vi.fn()); await vi.advanceTimersByTimeAsync(0); stop();
    change('new-grant'); expect(status.get('project', 'p', 's')).toBeUndefined();
    await status.dispose();
});

it('evicts idle projects at the cache limit and does not retain oversized projections', async () => {
    vi.useFakeTimers();
    let rowCount = 1;
    const status = new RemoteSessionStatus(id => id, async () => ({
        poll: async () => Array.from({ length: rowCount }, (_, index) => ({ profileId: 'p', sessionId: String(index),
            observation: { stale: false, canInterrupt: true, canRespond: true } } as HarnessStatusRow)), close: async () => {},
    }));
    for (let index = 0; index < 65; index++) {
        const stop = status.subscribe(String(index), vi.fn()); await vi.advanceTimersByTimeAsync(0); stop();
    }
    expect(status.get('0', 'p', '0')).toBeUndefined(); expect(status.get('64', 'p', '0')).toMatchObject({ stale: true });
    rowCount = 513;
    const stop = status.subscribe('oversized', vi.fn()); await vi.advanceTimersByTimeAsync(0); stop();
    expect(status.get('oversized', 'p', '0')).toBeUndefined();
    await status.dispose(); expect(vi.getTimerCount()).toBe(0);
});
