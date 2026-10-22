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
