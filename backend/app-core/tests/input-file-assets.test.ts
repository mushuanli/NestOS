import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context/digest';
import type {InputFileUpload} from '@itookit/app-contracts';
import {importInputFile, inspectInputFile} from '../src/runtime/input-file-assets';
import {readInputAsset, INPUT_ASSET_OWNER} from '../src/runtime/input-asset-store';

const logs = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', async original => ({...await original<typeof import('@itookit/common')>(), createModuleLogger: () => logs}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.clearAllMocks();});
async function setup(text = '\ufeffPrivate document') {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const backing = await manager.openFileSystem('/'), data = new TextEncoder().encode(text).buffer;
    const fs = {driver: backing.driver, meta: {
        assets: {putAsset: backing.meta.assets.putAsset.bind(backing.meta.assets), getAsset: backing.meta.assets.getAsset.bind(backing.meta.assets)},
        seq: {getEntry: backing.meta.seq!.getEntry.bind(backing.meta.seq), transaction: backing.meta.seq!.transaction!.bind(backing.meta.seq)},
    }} as unknown as typeof backing;
    const input: InputFileUpload = {uploadId: 'a1b2c3d4-1234-4123-8123-123456789abc', name: 'private-document.txt', mimeType: 'text/plain', bytes: data.byteLength, sha256: await sha256Hex(data), data};
    const {data: _data, ...identity} = input; return {fs, input, identity};
}

it.each(['text/plain', 'application/pdf', 'application/octet-stream'])('stores generic %s bytes with a stable identity and no file body in metadata', async mimeType => {
    const f = await setup(), input = {...f.input, mimeType}, identity = {...f.identity, mimeType};
    expect(await inspectInputFile(f.fs, identity)).toEqual({state: 'missing'});
    const reference = await importInputFile(f.fs, input);
    expect(reference.id).toBe(input.uploadId); expect(await readInputAsset(f.fs, reference)).toEqual(new Uint8Array(input.data));
    expect(await inspectInputFile(f.fs, identity)).toEqual({state: 'ready', reference});
    expect(await importInputFile(f.fs, input)).toEqual(reference);
    const metadata = await f.fs.meta.seq!.getEntry(INPUT_ASSET_OWNER, input.uploadId);
    expect(metadata).not.toContain('Private document'); expect(metadata).toContain(input.name);
    const logged = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls]);
    expect(logged).toContain(input.uploadId); expect(logged).not.toContain(input.name); expect(logged).not.toContain('Private document');
});

it('recovers a committed reservation whose acknowledgement was lost', async () => {
    const f = await setup(), transact = f.fs.meta.seq!.transaction!.bind(f.fs.meta.seq);
    vi.spyOn(f.fs.meta.seq!, 'transaction').mockImplementationOnce(async work => {await transact(work); throw new Error('Lost metadata acknowledgement');});
    const reference = await importInputFile(f.fs, f.input);
    expect(await inspectInputFile(f.fs, f.identity)).toEqual({state: 'ready', reference});
});

it('freezes caller-owned bytes before awaiting the storage reservation', async () => {
    const f = await setup(), expected = new Uint8Array(f.input.data).slice();
    const transact = f.fs.meta.seq!.transaction!.bind(f.fs.meta.seq);
    vi.spyOn(f.fs.meta.seq!, 'transaction').mockImplementationOnce(async work => {
        const result = await transact(work); new Uint8Array(f.input.data).fill(0); return result;
    });
    const reference = await importInputFile(f.fs, f.input);
    expect(await readInputAsset(f.fs, reference)).toEqual(expected);
});

it('confirms a lost blob-write acknowledgement by reading the same immutable content', async () => {
    const f = await setup(), put = f.fs.meta.assets.putAsset.bind(f.fs.meta.assets);
    const writes = vi.spyOn(f.fs.meta.assets, 'putAsset').mockImplementationOnce(async (...args) => {await put(...args); throw new Error('Lost content acknowledgement');});
    const reference = await importInputFile(f.fs, f.input);
    expect(await importInputFile(f.fs, f.input)).toEqual(reference); expect(writes).toHaveBeenCalledOnce();
});

it('keeps an incomplete reservation queryable and resumes the same upload without pretending it is ready', async () => {
    const f = await setup(); vi.spyOn(f.fs.meta.assets, 'putAsset').mockRejectedValueOnce(Object.assign(new Error('Private storage detail'), {code: 'ENOSPC'}));
    await expect(importInputFile(f.fs, f.input)).rejects.toMatchObject({code: 'INPUT_ASSET_WRITE_UNCONFIRMED', remoteCode: 'ENOSPC'});
    expect(await inspectInputFile(f.fs, f.identity)).toMatchObject({state: 'preparing', reference: {id: f.input.uploadId}});
    const reference = await importInputFile(f.fs, f.input); expect(await readInputAsset(f.fs, reference)).toEqual(new Uint8Array(f.input.data));
});

it('allows only one content identity to reserve a concurrent upload ID', async () => {
    const f = await setup(), data = new TextEncoder().encode('Different bytes').buffer;
    const other = {...f.input, data, bytes: data.byteLength, sha256: await sha256Hex(data)};
    const results = await Promise.allSettled([importInputFile(f.fs, f.input), importInputFile(f.fs, other)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(row => row.status === 'rejected')).toMatchObject({reason: {code: 'INPUT_ASSET_CONFLICT'}});
    const winner = results.find(row => row.status === 'fulfilled')!;
    if (winner.status === 'fulfilled') expect(await readInputAsset(f.fs, winner.value)).toEqual(new Uint8Array(results[0].status === 'fulfilled' ? f.input.data : data));
});

it('detects reused names and corrupt stored bytes without overwriting the original content', async () => {
    const f = await setup(), reference = await importInputFile(f.fs, f.input);
    await expect(importInputFile(f.fs, {...f.input, name: 'renamed.txt'})).rejects.toMatchObject({code: 'INPUT_ASSET_CONFLICT'});
    await expect(inspectInputFile(f.fs, {...f.identity, name: 'renamed.txt'})).rejects.toMatchObject({code: 'INPUT_ASSET_CONFLICT'});
    await f.fs.meta.assets.putAsset(INPUT_ASSET_OWNER, `${reference.sha256}.bin`, new Uint8Array([1, 2]).buffer);
    await expect(importInputFile(f.fs, f.input)).rejects.toMatchObject({code: 'INPUT_ASSET_INTEGRITY'});
    expect(await f.fs.meta.assets.getAsset(INPUT_ASSET_OWNER, `${reference.sha256}.bin`)).toEqual(new Uint8Array([1, 2]).buffer);
});

it('supports an explicitly empty file while rejecting bad identities before creating storage', async () => {
    const f = await setup(''), reference = await importInputFile(f.fs, f.input);
    expect((await readInputAsset(f.fs, reference)).length).toBe(0);
    await expect(importInputFile(f.fs, {...f.input, uploadId: 'private-invalid-input'})).rejects.toMatchObject({code: 'INPUT_ASSET_IDENTITY'});
    await expect(importInputFile(f.fs, {...f.input, name: '../secret'})).rejects.toMatchObject({code: 'INPUT_ASSET_NAME'});
    await expect(importInputFile(f.fs, {...f.input, data: new Uint8Array([1]).buffer})).rejects.toMatchObject({code: 'INPUT_ASSET_CONTENT_MISMATCH'});
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('private-invalid-input');
});
