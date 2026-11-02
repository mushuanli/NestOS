import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createInfrastructure} from '../src/runtime/infrastructure';
import {UserEventService} from '../src/events/service';
import {projectKernelEvents} from '../src/events/kernel-source';
import {attachRuntimeEvents} from '../src/events/runtime-events';

let infrastructure: Awaited<ReturnType<typeof createInfrastructure>>;
let service: UserEventService;
const sessionId = 'recovery-session', key = 'kernel/' + sessionId;
const failure = (code: string) => Object.assign(new Error('source failure'), {code});
beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    infrastructure = await createInfrastructure({backend: new MemoryBackend()});
    service = await UserEventService.open(infrastructure.systemFS);
});
afterEach(async () => {service?.journal.close(); await infrastructure?.vfs.dispose(); vi.restoreAllMocks();});
const checkpoint = () => service.journal.transaction(tx => tx.getState(key));
const save = (value: string) => service.journal.transaction(tx => tx.setState(key, value));
function fixture() {
    const source = {snapshot: vi.fn(async () => ({asOfSequence: 3})),
        readEvents: vi.fn(async ({afterSequence}: {afterSequence: number}) => {
            if (afterSequence > 3) throw failure('INVALID_SPEC');
            return {items: [], throughSequence: 3};
        })};
    const kernel = {inspectSession: vi.fn(async () => source), onChanged: vi.fn(() => () => {}),
        async *listSessions() {yield {id: sessionId};}};
    const run = () => projectKernelEvents(service, kernel as unknown as Parameters<typeof projectKernelEvents>[1], sessionId);
    return {source, kernel, run};
}
it('repairs a checkpoint ahead of the source and resumes from the new baseline', async () => {
    const f = fixture(); await save('90'); await f.run();
    expect(await checkpoint()).toBe('3');
    expect((await service.readEvents()).events.map(event => event.value)).toEqual([
        {type: 'source.reset', resourceId: sessionId, sourceSequence: 3}]);
    expect(console.warn).toHaveBeenCalledWith('[ApplicationEvents]', expect.objectContaining({
        code: 'EVENT_CHECKPOINT_AHEAD', afterSequence: 90, asOfSequence: 3, result: 'success'}));
    await f.run(); expect(f.source.readEvents).toHaveBeenLastCalledWith({afterSequence: 3, limit: 200});
    expect((await service.readEvents()).events).toHaveLength(1);
});
it.each(['not-a-number', '-1', '1.5', '9007199254740992', '', ' '])('repairs an invalid checkpoint without sending it to the Kernel: %j', async raw => {
    const f = fixture(); await save(raw); await f.run();
    expect(await checkpoint()).toBe('3'); expect(f.source.readEvents).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('not-a-number');
});
it('retains the existing recovery for pruned event history', async () => {
    const f = fixture(); await save('1'); f.source.readEvents.mockRejectedValueOnce(failure('CURSOR_EXPIRED'));
    await f.run(); expect(await checkpoint()).toBe('3');
});
it.each(['INVALID_SPEC', 'STORAGE_CORRUPT', 'EIO'])('does not disguise unrelated source errors: %s', async code => {
    const f = fixture(), error = failure(code); await save('1'); f.source.readEvents.mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error); expect(await checkpoint()).toBe('1');
    expect((await service.readEvents()).events).toHaveLength(0);
});
it('does not overwrite a concurrently advanced checkpoint', async () => {
    const f = fixture(); await save('90');
    f.source.snapshot.mockImplementationOnce(async () => {await save('2'); return {asOfSequence: 3};});
    await f.run(); expect(await checkpoint()).toBe('2');
    expect((await service.readEvents()).events).toHaveLength(0);
});
it('completes startup replay when a persisted checkpoint exceeds the Kernel history', async () => {
    const f = fixture(); await save('90');
    const sources = {kernel: {kernel: f.kernel}, sessionRepository: {}, digitalTwin: undefined};
    const projection = await attachRuntimeEvents(service, sources as unknown as Parameters<typeof attachRuntimeEvents>[1], infrastructure.systemFS);
    try {
        expect(await checkpoint()).toBe('3');
        expect((await service.readEvents()).events.map(event => event.value.type)).toEqual(['source.reset', 'runtime.reset']);
    } finally {await projection.dispose();}
});
