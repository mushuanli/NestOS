import {EventEmitter} from 'node:events';
import type {ServerResponse} from 'node:http';
import {expect, it, vi} from 'vitest';
import {ViewEventStream} from '../../node-host/src/http/view-event-stream';

function response() {
    return Object.assign(new EventEmitter(), {write: vi.fn(), end: vi.fn(), writableLength: 0}) as unknown as ServerResponse & {write: ReturnType<typeof vi.fn>};
}

it('retains offline events, replays only missing frames and detaches the old stream', () => {
    const journal = new ViewEventStream(), first = response(), second = response();
    journal.attach(first); journal.write('data: {"before":true}\n\n');
    first.emit('close'); journal.write('data: {"missed":true}\n\n');
    expect(first.write).toHaveBeenCalledTimes(1); expect(journal.canResume(1)).toBe(true);
    journal.attach(second, 1);
    expect(second.write).toHaveBeenCalledExactlyOnceWith('id: 2\ndata: {"missed":true}\n\n');
    first.emit('close'); journal.write('data: {}\n\n');
    expect(second.write).toHaveBeenCalledTimes(2); journal.end();
});

it('rejects cursors outside retained history and bounds replay by both frame count and bytes', () => {
    const journal = new ViewEventStream();
    for (let index = 0; index < 257; index++) journal.write('data: {}\n\n');
    expect(journal.canResume(0)).toBe(false); expect(journal.canResume(1)).toBe(true);
    expect(journal.canResume(258)).toBe(false); expect(journal.canResume(NaN)).toBe(false);
    journal.write('x'.repeat(1024 * 1024)); journal.write('x'.repeat(1024 * 1024));
    expect(journal.canResume(257)).toBe(false); expect(journal.canResume(258)).toBe(true);
    journal.end(); expect(journal.canResume(259)).toBe(false);
});

it('invalidates an overloaded stream instead of keeping a partial replay', () => {
    const journal = new ViewEventStream(), stream = response(); journal.attach(stream);
    Object.defineProperty(stream, 'writableLength', {value: 1024 * 1024 + 1});
    expect(journal.write('data: {}\n\n')).toBe(false);
    expect(stream.end).toHaveBeenCalledOnce(); expect(journal.canResume(0)).toBe(false);
    expect(journal.write('data: {}\n\n')).toBe(false);
});

it('keeps legacy SSE framing until sequence support is explicitly requested', () => {
    const journal = new ViewEventStream(), legacy = response(), resumed = response();
    journal.write('data: {"first":true}\n\n'); journal.attach(legacy, 0, false);
    journal.write('data: {"second":true}\n\n');
    expect(legacy.write.mock.calls.map(([frame]) => JSON.parse(frame.slice(6)))).toEqual([{first: true}, {second: true}]);
    journal.attach(resumed, 1, true);
    expect(resumed.write).toHaveBeenCalledExactlyOnceWith('id: 2\ndata: {"second":true}\n\n'); journal.end();
});
