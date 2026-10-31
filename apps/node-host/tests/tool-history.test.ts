import {it, expect} from 'vitest';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {Tool} from '@itookit/tools';
import {ToolHistory} from '../src/runtime/tool-packages/history';
it('persists bounded private metadata, running state and sanitized failures across restarts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-history-')), file = path.join(root, 'private/history.json');
    try {
        const history = new ToolHistory(file); await history.initialize();
        let finish!: () => void;
        const tool = {name: 'fixture', version: '1', call: async () => {await new Promise<void>(resolve => {finish = resolve;}); return {data: 'PRIVATE_RESULT'};}} as unknown as Tool;
        const running = history.call(tool, 'package@1', {secret: 'PRIVATE_ARGUMENT'}, {} as never);
        while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
        expect(history.busy('package@1')).toBe(true); expect(history.list('package@1')[0].status).toBe('running');
        const recovered = new ToolHistory(file); await recovered.initialize(); expect(recovered.list('package@1')[0].status).toBe('unknown');
        finish(); await running;
        expect(history.list('package@1')[0]).toMatchObject({toolId: 'fixture', status: 'succeeded', durationMs: expect.any(Number)});
        tool.call = async () => {throw Object.assign(new Error('PRIVATE_EXCEPTION'), {code: 'NETWORK_UNAVAILABLE'});};
        await expect(history.call(tool, 'package@1', {}, {} as never)).rejects.toThrow('PRIVATE_EXCEPTION');
        expect(history.list('package@1')[0]).toMatchObject({status: 'failed', code: 'NETWORK_UNAVAILABLE'});
        expect(await readFile(file, 'utf8')).not.toContain('PRIVATE_'); expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(history.list('another@1')).toEqual([]);
    } finally {await rm(root, {recursive: true, force: true});}
});

it('persists only validated collection counts, including zero, without retaining result bodies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tool-history-count-')), file = path.join(root, 'history.json');
    try {
        const history = new ToolHistory(file); await history.initialize();
        const collection = {version: 1, complete: false, processed: 12, batchCount: 0};
        const tool = {name: 'fixture', call: async () => ({data: {collection: {...collection, secret: 'PRIVATE_RESULT'}, body: 'PRIVATE_BODY'}})} as unknown as Tool;
        await history.call(tool, 'package@1', {}, {} as never);
        const recovered = new ToolHistory(file); await recovered.initialize();
        expect(recovered.list('package@1')[0].collection).toEqual(collection);
        expect(await readFile(file, 'utf8')).not.toContain('PRIVATE_');
        tool.call = async () => ({data: {collection: {...collection, batchCount: -1}}}) as never;
        await history.call(tool, 'package@1', {}, {} as never);
        expect(history.list('package@1')[0].collection).toBeUndefined();
        expect(history.list('package@1')[0].status).toBe('succeeded');
    } finally {await rm(root, {recursive: true, force: true});}
});
