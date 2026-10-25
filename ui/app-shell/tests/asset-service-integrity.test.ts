import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {AssetService} from '../../llm-ui-adapter/src/services/AssetService';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
async function setup() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'); return {fs, assets: new AssetService(fs)};
}
const bytes = (text: string) => new TextEncoder().encode(text).buffer;

it('reconciles a lost attachment write response without replacing its immutable content', async () => {
    const {fs, assets} = await setup(), original = fs.driver.createFile.bind(fs.driver);
    const write = vi.spyOn(fs.driver, 'createFile').mockImplementationOnce(async args => {
        await original(args); throw new Error('Lost response');
    });
    await assets.createAsset('submission-0.txt', bytes('original'));
    await assets.createAsset('submission-0.txt', bytes('original'));
    expect(write).toHaveBeenCalledTimes(2);
    expect(await fs.driver.readContent('/submission-0.txt', {encoding: 'binary'})).toEqual(bytes('original'));
});

it('rejects changed bytes under an accepted attachment name and keeps the original file', async () => {
    const {fs, assets} = await setup(); await assets.createAsset('submission-0.txt', bytes('original'));
    await expect(assets.createAsset('submission-0.txt', bytes('changed'))).rejects.toMatchObject({code: 'EEXIST'});
    expect(await fs.driver.readContent('/submission-0.txt', {encoding: 'binary'})).toEqual(bytes('original'));
});

it('returns one consistent reference and content identity for submission retry, including an empty file', async () => {
    const {assets} = await setup();
    const file = {name: 'empty.txt', type: 'text/plain', arrayBuffer: async () => bytes('')} as File;
    const first = await assets.prepareUpload([file], 'submission');
    expect(await assets.prepareUpload([file], 'submission')).toEqual(first);
    expect(first.references).toEqual(['[empty.txt](@asset/submission-0.txt)']);
    expect(first.files[0]).toMatchObject({name: 'submission-0.txt', size: 0,
        content: {bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}});
});

it('reports a safe read failure without disclosing file names or original error text', async () => {
    const {assets} = await setup(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = {name: 'PRIVATE_NAME.txt', arrayBuffer: async () => {throw new Error('PRIVATE_STORAGE_DETAIL');}} as unknown as File;
    await expect(assets.prepareUpload([file], 'submission')).rejects.toMatchObject({code: 'ATTACHMENT_READ_FAILED'});
    expect(JSON.stringify(log.mock.calls)).toContain('ATTACHMENT_READ_FAILED');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_NAME|PRIVATE_STORAGE_DETAIL/);
});
