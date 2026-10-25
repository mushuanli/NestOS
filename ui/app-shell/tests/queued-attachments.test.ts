// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createVFS, MemoryBackend } from '@itookit/vfs-core';
import { AssetService } from '../../llm-ui-adapter/src/services/AssetService';

it('keeps same-name attachments from different submissions immutable while the queue waits', async () => {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    try {
        const fs = await manager.openFileSystem('/assets'), assets = new AssetService(fs);
        const file = (text: string) => ({ name: 'same-name.txt', type: 'text/plain',
            arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as File;
        const first = await assets.uploadFiles([file('first bytes')], 'first-submission');
        const second = await assets.uploadFiles([file('second bytes')], 'second-submission');
        expect(first).toEqual(['[same-name.txt](@asset/first-submission-0.txt)']);
        expect(second).toEqual(['[same-name.txt](@asset/second-submission-0.txt)']);
        expect(await fs.driver.readContent('/first-submission-0.txt', { encoding: 'utf-8' })).toBe('first bytes');
        expect(await fs.driver.readContent('/second-submission-0.txt', { encoding: 'utf-8' })).toBe('second bytes');
    } finally { await manager.dispose(); }
});

it('binds uploaded content to the submission and refuses different bytes under the same identity', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/assets'), assets = new AssetService(fs);
        const file = (text: string) => ({name: 'same.txt', type: 'text/plain', arrayBuffer: async () => new TextEncoder().encode(text).buffer}) as File;
        const prepared = await assets.prepareUpload([file('first')], 'same-submission');
        expect(prepared.files[0]).toMatchObject({name: 'same-submission-0.txt', size: 5,
            content: {bytes: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/)}});
        expect(await assets.prepareUpload([file('first')], 'same-submission')).toEqual(prepared);
        await expect(assets.prepareUpload([file('other')], 'same-submission')).rejects.toMatchObject({code: 'EEXIST'});
        expect(await fs.driver.readContent('/same-submission-0.txt', {encoding: 'utf-8'})).toBe('first');
    } finally {await manager.dispose();}
});
