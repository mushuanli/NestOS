import {afterEach, expect, it, vi} from 'vitest';
import {ViewUpdateReads} from '../../node-host/src/http/view-update-reads';
import {ViewNotifications} from '../../node-host/src/http/view-notifications';

afterEach(() => {vi.useRealTimers();});
const large = (content = 'PRIVATE_BODY') => JSON.stringify({updates: [], padding: content.repeat(10000)});
it('keeps small changes inline and exposes a repeatable read for large prepared updates', () => {
    const write = vi.fn(), reads = new ViewUpdateReads({write, close: async () => {}});
    expect(reads.stage('{"updates":[]}')).toBe('{"updates":[]}');
    const data = large(), ref = JSON.parse(reads.stage(data));
    expect(ref).toEqual({updatesRead: expect.any(String)});
    expect(reads.read(ref.updatesRead, 'request')).toEqual(JSON.parse(data));
    expect(reads.read(ref.updatesRead)).toEqual(JSON.parse(data));
    expect(JSON.stringify(write.mock.calls)).not.toContain('PRIVATE_BODY');
    expect(write).toHaveBeenCalledWith(expect.objectContaining({stage: 'read', requestId: 'request', result: 'success', bytes: Buffer.byteLength(data)}));
});
it('isolates prepared reads per view and clears them with their owner', () => {
    const first = new ViewUpdateReads(), second = new ViewUpdateReads(), ref = JSON.parse(first.stage(large()));
    expect(() => second.read(ref.updatesRead)).toThrow('expired'); first.clear();
    expect(() => first.read(ref.updatesRead)).toThrow('expired');
});
it('expires old reads and bounds entries without retaining all previous notifications', () => {
    vi.useFakeTimers(); const reads = new ViewUpdateReads(), ref = JSON.parse(reads.stage(large()));
    for (let i = 0; i < 32; i++) reads.stage(large());
    expect(() => reads.read(ref.updatesRead)).toThrow('expired');
    const latest = JSON.parse(reads.stage(large())); vi.advanceTimersByTime(60000);
    expect(() => reads.read(latest.updatesRead)).toThrow('expired');
});
it('stages a large notification once while preserving its events and snapshot order', async () => {
    vi.useFakeTimers(); const reads = new ViewUpdateReads(), write = vi.fn(), refresh = vi.fn(async () => []), report = vi.fn();
    const queue = new ViewNotifications(() => ({write, destroyed: false, writableLength: 0, end() {}}), refresh, report, 16, data => reads.stage(data));
    await queue.enqueue({target: 'observer', method: 'call', args: ['x'.repeat(100000)], notification: true});
    await vi.advanceTimersByTimeAsync(16);
    const ref = JSON.parse(write.mock.calls[0][0].slice(6)), packet = reads.read(ref.updatesRead) as {calls: unknown[]};
    expect(packet.calls).toHaveLength(1); expect(refresh).toHaveBeenCalledOnce(); expect(report).not.toHaveBeenCalled(); queue.close();
});
