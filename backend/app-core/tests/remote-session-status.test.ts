import { afterEach, expect, it, vi } from 'vitest';
import { RemoteSessionStatus } from '../src/session/remote-session-status';
import type { HarnessStatusRow } from '@itookit/piagent-driver';

afterEach(() => vi.useRealTimers());
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
    version = 'watch:2'; await vi.advanceTimersByTimeAsync(1000); expect(changed).toHaveBeenCalledTimes(2);
    change(); expect(status.fileVersion('project')).toBeUndefined(); await status.dispose();
});
