import { expect, it, vi } from 'vitest';
import { checkOperation, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService } from '@itookit/app-contracts/services';
import { ProjectSearch } from '../src/projects/project-search';

function fixture(delays: number[]) {
    let active = 0, peak = 0;
    const search = vi.fn(async (id: string, _query: unknown, options: OperationOptions) => {
        active++; peak = Math.max(peak, active);
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, delays[Number(id)]);
                options.signal?.addEventListener('abort', () => {clearTimeout(timer); reject(new Error('Aborted'));}, {once: true});
            });
            checkOperation(options);
            return {matches: [{sessionId: id, title: id, summary: 'needle'}], truncated: false, nextCursor: null};
        } finally {active--;}
    });
    const close = vi.fn(async () => {}), client = {search, close, profiles: async () => ({profiles: delays.map((_, index) => ({id: String(index),
        projectRuntime: true, capabilities: {search: true, searchPrompts: true}}))})};
    const service = new ProjectSearch({forFolder: async () => ({path: '/P', project: {id: 'p'}}),
        remoteMounts: {list: () => [], projectHarness: async () => client}} as unknown as ProjectService);
    return {service, search, close, peak: () => peak, active: () => active};
}

it('lets slow native sources finish within one shared budget with at most two scans active', async () => {
    vi.useFakeTimers();
    const f = fixture([9000, 12000, 10]);
    try {
        const result = f.service.search('/P', {query: 'needle', scope: 'session-content'});
        const assertion = expect(result).resolves.toMatchObject({matches: [{profileId: '0'}, {profileId: '1'}, {profileId: '2'}], truncated: false});
        await vi.advanceTimersByTimeAsync(12_001); await assertion;
        expect(f.peak()).toBe(2); expect(f.active()).toBe(0); expect(f.close).toHaveBeenCalledOnce();
    } finally {vi.useRealTimers();}
});

it('keeps completed results when the shared deadline expires and skips queued scans', async () => {
    vi.useFakeTimers();
    const f = fixture([1000, 30000, 30000, 10]);
    try {
        const result = f.service.search('/P', {query: 'needle', scope: 'session-prompt'});
        const assertion = expect(result).resolves.toMatchObject({matches: [{profileId: '0'}], truncated: true, unavailableSources: ['1', '2', '3']});
        await vi.advanceTimersByTimeAsync(18_001); await assertion;
        expect(f.search.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2']);
        expect(f.active()).toBe(0); expect(f.close).toHaveBeenCalledOnce();
    } finally {vi.useRealTimers();}
});

it('propagates caller cancellation and drains active scans before closing the client', async () => {
    vi.useFakeTimers();
    const f = fixture([9000, 12000, 10]), controller = new AbortController();
    try {
        const result = f.service.search('/P', {query: 'needle', scope: 'session-content'}, {signal: controller.signal});
        const assertion = expect(result).rejects.toBeDefined();
        await vi.advanceTimersByTimeAsync(100); controller.abort(); await assertion;
        expect(f.search).toHaveBeenCalledTimes(2); expect(f.active()).toBe(0); expect(f.close).toHaveBeenCalledOnce();
    } finally {vi.useRealTimers();}
});
