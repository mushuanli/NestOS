import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Kernel} from '@itookit/durable-kernel';
import {createVFS, MemoryBackend, FSError, type IVFSManager, type IFileSystem} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context';
import {TaskArtifacts} from '../src/session/task-artifacts';
import {createTaskAssetStore} from '../src/runtime/task-asset-store';
import {createTaskAssetReader} from '../src/runtime/task-assets';
import type {ExecutionArtifactDescriptor} from '@itookit/app-contracts';

let manager: IVFSManager, fs: IFileSystem, kernel: Kernel, artifacts: TaskArtifacts;
const values = new Map<string, unknown>();
const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()};
beforeEach(async () => {
    ({manager} = await createVFS({rootBackend: new MemoryBackend()})); fs = await manager.openFileSystem('/');
    kernel = new Kernel({catalog: {fs}, pollMs: 5});
    kernel.registerStorageResolver({kind: 'test', resolve: async ref => ({fs, rootPath: ref.locator === 'other' ? '/other' : '/s'})});
    kernel.programs.register({manifest: {kind: 'fixture-output', version: '1'},
        init: (input: unknown) => ({state: null, next: {type: 'complete', output: values.get(String(input))}}),
        reduce: () => ({state: null, next: {type: 'fail', error: {name: 'Unused', message: 'Unexpected fixture reduction'}}})});
    await kernel.initialize(); await kernel.createSession({id: 's', storage: {kind: 'test', locator: null}});
    artifacts = new TaskArtifacts(kernel, createTaskAssetReader(() => kernel, fs), logger); vi.clearAllMocks();
});
afterEach(async () => {kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); values.clear();});

async function publish(value: unknown, label = 'value') {
    values.set(label, value);
    const task = await (await kernel.openSession('s')).submit({program: {kind: 'fixture-output', version: '1'}, input: label,
        labels: {invocationId: 'invocation-fixture'}});
    await task.wait({timeoutMs: 4000}); return task;
}
async function allBytes(descriptor: ExecutionArtifactDescriptor, limit = 4) {
    let offset = 0; const bytes: number[] = [];
    do {
        const chunk = await artifacts.read({reference: descriptor.reference, offset, limit});
        expect(chunk.offset).toBe(offset); expect(chunk.sha256).toBe(descriptor.sha256);
        bytes.push(...new Uint8Array(chunk.data)); if (chunk.nextOffset === undefined) break; offset = chunk.nextOffset;
    } while (true);
    return new Uint8Array(bytes);
}

it('paginates committed text/JSON outputs and reads byte ranges without opening or mutating execution', async () => {
    const task = await publish({outputs: {report: {outputName: 'report', type: 'text', content: '中文 report'},
        value: {outputName: 'value', type: 'json', content: {zero: 0, flag: false}}}});
    const original = await kernel.task('s', task.id), open = vi.spyOn(kernel, 'openSession'), list = vi.spyOn(kernel, 'listSessions');
    const first = await artifacts.list({sessionId: 's', taskId: task.id, limit: 1});
    expect(first.items).toHaveLength(1); expect(first.nextOffset).toBe(1);
    expect(first.items[0]).toMatchObject({kind: 'text', invocationId: 'invocation-fixture'});
    const data = await allBytes(first.items[0]); expect(new TextDecoder().decode(data)).toBe('中文 report');
    expect(await sha256Hex(data)).toBe(first.items[0].sha256);
    const second = await artifacts.list({sessionId: 's', taskId: task.id, offset: first.nextOffset, limit: 1});
    expect(second.nextOffset).toBeUndefined(); expect(JSON.parse(new TextDecoder().decode(await allBytes(second.items[0])))).toEqual({zero: 0, flag: false});
    expect(await kernel.task('s', task.id)).toEqual(original); expect(open).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
});

it('pins the exact output selection and refuses invented paths, changed fingerprints and other Sessions', async () => {
    const task = await publish({outputs: {answer: {outputName: 'answer', type: 'text', content: 'answer'}}});
    const [entry] = (await artifacts.list({sessionId: 's', taskId: task.id})).items;
    await expect(artifacts.read({reference: {...entry.reference, artifactId: entry.reference.artifactId.replace(/.$/, x => x === '0' ? '1' : '0')}}))
        .rejects.toMatchObject({code: 'ARTIFACT_CHANGED'});
    await expect(artifacts.read({reference: {...entry.reference, artifactId: entry.reference.artifactId.replace(encodeURIComponent('/outputs/answer/content'), encodeURIComponent('/input/secret'))}}))
        .rejects.toMatchObject({code: 'ARTIFACT_NOT_FOUND'});
    await kernel.createSession({id: 'other', storage: {kind: 'test', locator: 'other'}});
    await expect(artifacts.read({reference: {...entry.reference, sessionId: 'other'}})).rejects.toThrow();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('answer/content');
});

it('reads selected Task assets with content verification and rejects corruption', async () => {
    const session = await kernel.openSession('s');
    const task = await session.submit({program: {kind: 'fixture-output', version: '1'}, input: 'binary', deferStart: true});
    const ref = await createTaskAssetStore(() => kernel).write(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream',
        {sessionId: 's', taskId: task.id, operationId: 'binary', effectId: 'asset'});
    values.set('binary', {outputs: {file: {outputName: 'file', type: 'file', content: ref}}});
    await task.start(); await task.wait({timeoutMs: 4000});
    const [entry] = (await artifacts.list({sessionId: 's', taskId: task.id})).items;
    expect(entry.kind).toBe('binary'); expect(await allBytes(entry, 2)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const consumer = await publish({asset: ref}, 'unrelated-consumer');
    const copied = (await artifacts.list({sessionId: 's', taskId: consumer.id})).items.find(item => item.kind === 'binary')!;
    await expect(artifacts.read({reference: copied.reference})).rejects.toMatchObject({code: 'ARTIFACT_BINARY_SCOPE_DENIED'});
    await fs.meta.assets.putAsset('/s/' + ref.owner, ref.name, new Uint8Array([4, 3, 2, 1]).buffer);
    await expect(artifacts.read({reference: entry.reference})).rejects.toMatchObject({code: 'ARTIFACT_BINARY_INTEGRITY'});
    const deniedAssets = new Proxy(fs.meta.assets, {get: (target, key) => key === 'getAsset'
        ? async () => {throw new FSError('EACCES', 'SECRET STORAGE PATH');} : Reflect.get(target, key)});
    const deniedMeta = new Proxy(fs.meta, {get: (target, key) => key === 'assets' ? deniedAssets : Reflect.get(target, key)});
    const deniedFS = new Proxy(fs, {get: (target, key) => key === 'meta' ? deniedMeta : Reflect.get(target, key)});
    const read = vi.spyOn(kernel.storageResolvers.resolve('test'), 'resolve').mockResolvedValue({fs: deniedFS, rootPath: '/s'});
    try {
        await expect(artifacts.read({reference: entry.reference})).rejects.toMatchObject({code: 'ARTIFACT_STORAGE_DENIED'});
        expect(logger.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({storageCode: 'EACCES'}));
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET STORAGE PATH');
    } finally {read.mockRestore();}
});

it('does not fetch remote paths and reports file outputs that were never imported', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected remote fetch'));
    try {
        const task = await publish({outputs: {file: {outputName: 'file', type: 'file', content: {uri: 'https://private.invalid/file'}}}});
        const [entry] = (await artifacts.list({sessionId: 's', taskId: task.id})).items;
        expect(entry).toMatchObject({kind: 'unavailable', unavailableReason: 'ARTIFACT_FILE_NOT_IMPORTED'});
        await expect(artifacts.read({reference: entry.reference})).rejects.toMatchObject({code: 'ARTIFACT_FILE_NOT_IMPORTED'});
        await expect(artifacts.context('s', entry.reference.artifactId)).rejects.toMatchObject({code: 'ARTIFACT_CONTEXT_UNSUPPORTED'});
        expect(fetch).not.toHaveBeenCalled();
    } finally {fetch.mockRestore();}
});

it('returns exact semantic values and rendering hashes for context artifacts', async () => {
    const task = await publish({outputs: {value: {outputName: 'value', type: 'json', content: 'a JSON string'}}});
    const [entry] = (await artifacts.list({sessionId: 's', taskId: task.id})).items;
    const artifact = await artifacts.context('s', entry.reference.artifactId);
    expect(artifact.content).toBe('a JSON string'); expect(artifact.contentHash).toBe(await sha256Hex('a JSON string'));
    expect(new TextDecoder().decode(await allBytes(entry))).toBe('"a JSON string"');
});


it('rejects invalid ranges and forged Task references before reading bytes', async () => {
    const task = await publish('result');
    const [entry] = (await artifacts.list({sessionId: 's', taskId: task.id})).items;
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 7])
        await expect(artifacts.read({reference: entry.reference, offset})).rejects.toMatchObject({code: 'ARTIFACT_RANGE_INVALID'});
    await expect(artifacts.read({reference: {...entry.reference, taskId: 'forged'}})).rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
    await expect(artifacts.list({sessionId: 's', taskId: task.id, limit: 101})).rejects.toMatchObject({code: 'ARTIFACT_RANGE_INVALID'});
});

it('bounds catalog traversal even for a wide array of binary references', async () => {
    const {artifactCandidates} = await import('../src/session/artifact-catalog');
    const ref = {kind: 'input', id: 'asset', bytes: 0, mimeType: 'text/plain', sha256: '0'.repeat(64)};
    expect(() => [...artifactCandidates(Array(20001).fill(ref))]).toThrow('traversal limits');
});

it('does not log arbitrary storage error details from an asset reader', async () => {
    const ref = {sessionId: 's', taskId: 'owner', owner: 'asset', name: 'file', bytes: 0, mimeType: 'text/plain', sha256: '0'.repeat(64)};
    const task = await publish(ref);
    const broken = new TaskArtifacts(kernel, async () => {throw Object.assign(new Error('PRIVATE_BODY'), {storageCode: 'PRIVATE PATH /secret'});}, logger);
    const [entry] = (await broken.list({sessionId: 's', taskId: task.id})).items;
    await expect(broken.read({reference: entry.reference})).rejects.toMatchObject({code: 'ARTIFACT_BINARY_UNAVAILABLE'});
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/PRIVATE|secret/);
});


it('rejects output reads before the execution commits a terminal result without starting it', async () => {
    const task = await (await kernel.openSession('s')).submit({program: {kind: 'fixture-output', version: '1'}, input: 'pending', deferStart: true});
    const before = await kernel.task('s', task.id), open = vi.spyOn(kernel, 'openSession');
    await expect(artifacts.list({sessionId: 's', taskId: task.id})).rejects.toMatchObject({code: 'ARTIFACT_OUTPUT_PENDING'});
    expect(await kernel.task('s', task.id)).toEqual(before); expect(open).not.toHaveBeenCalled();
});
