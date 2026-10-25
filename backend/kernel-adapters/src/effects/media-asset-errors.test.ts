import {expect, it, vi} from 'vitest';
import type {IFileSystem} from '@itookit/vfs-core';
import {sha256Hex} from '@itookit/llm-context/digest';
import {readMediaAsset} from './media-result-store';

it.each(['identity', 'missing', 'integrity', 'denied', 'unknown'] as const)('classifies %s Task asset failures without exposing storage details', async mode => {
    const bytes = new Uint8Array([1, 2, 3]), digest = await sha256Hex(bytes);
    const asset = {sessionId: 's', taskId: 't', owner: 'tasks/t/task.seq', name: `${digest}.bin`,
        sha256: digest, bytes: bytes.length, mimeType: 'image/png'};
    const getAsset = vi.fn(async (): Promise<ArrayBuffer | undefined> => bytes.buffer);
    if (mode === 'identity') asset.taskId = 'foreign';
    if (mode === 'missing') getAsset.mockResolvedValue(undefined);
    if (mode === 'integrity') getAsset.mockResolvedValue(new Uint8Array([4, 5, 6]).buffer);
    if (mode === 'denied' || mode === 'unknown') getAsset.mockRejectedValue(Object.assign(new Error('Private path and file contents'),
        {code: mode === 'denied' ? 'EACCES' : 'Private storage token'}));
    const fs = {meta: {assets: {getAsset}}} as unknown as IFileSystem;
    const code = {identity: 'MEDIA_ASSET_IDENTITY', missing: 'MEDIA_ASSET_MISSING', integrity: 'MEDIA_ASSET_INTEGRITY',
        denied: 'MEDIA_ASSET_READ_FAILED', unknown: 'MEDIA_ASSET_READ_FAILED'}[mode];
    const error = await readMediaAsset(fs, '/s', asset, {sessionId: 's', taskId: 't'}).catch(error => error);
    expect(error).toMatchObject({code});
    expect(String(error)).not.toContain('Private'); expect(JSON.stringify(error)).not.toContain('Private');
    if (mode === 'denied') expect(error).toHaveProperty('storageCode', 'EACCES');
    else expect(error).not.toHaveProperty('storageCode');
    if (mode === 'identity') expect(getAsset).not.toHaveBeenCalled();
});
