import {randomUUID} from '@itookit/common';
import {sha256Hex} from '@itookit/llm-context';
import type {InputAssetReference} from '@itookit/tools/contracts';
import type {IFileSystem} from '@itookit/vfs-core';
import type {CommandBus} from '@itookit/llm-session';
import {InputAssetCommand} from '@itookit/app-contracts';
import {readInputAsset, inputAssetError, INPUT_ASSET_OWNER as owner} from './input-asset-store';
import {importInputFile, inspectInputFile} from './input-file-assets';
export {readInputAsset} from './input-asset-store';
const maxBytes = 20 * 1024 * 1024;

export async function importInputAsset(fs: IFileSystem, url: string): Promise<InputAssetReference> {
    if (typeof url !== 'string') throw inputAssetError('INPUT_ASSET_FORMAT', 'Expected an image data URL');
    if (url.length > Math.ceil(maxBytes / 3) * 4 + 256) throw inputAssetError('INPUT_ASSET_TOO_LARGE', 'Image exceeds the per-file upload limit (20 MiB)');
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || match[2].length % 4) throw inputAssetError('INPUT_ASSET_FORMAT', 'Invalid image data; uploads support PNG, JPEG and WebP');
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    if (!bytes.length) throw inputAssetError('INPUT_ASSET_FORMAT', 'Image data is empty');
    if (bytes.length > maxBytes) throw inputAssetError('INPUT_ASSET_TOO_LARGE', 'Image exceeds the per-file upload limit (20 MiB)');
    return persistInputAsset(fs, bytes, match[1]);
}

async function persistInputAsset(fs: IFileSystem, bytes: Uint8Array, mimeType: string): Promise<InputAssetReference> {
    try {
        if (!await fs.driver.exists(owner)) {
            try {await fs.driver.createFile({parentPath: '/var/lib', name: 'inputs.seq', type: 'seqfile', recursive: true});}
            catch (error) {if (!await fs.driver.exists(owner)) throw error;}
        }
        const ref: InputAssetReference = {kind: 'input', id: randomUUID(), mimeType, bytes: bytes.length, sha256: await sha256Hex(bytes)};
        await fs.meta.assets.putAsset(owner, `${ref.id}.bin`, new Uint8Array(bytes).buffer);
        await fs.meta.seq!.setEntry(owner, ref.id, JSON.stringify(ref));
        await readInputAsset(fs, ref); return ref;
    } catch (error) { throw inputAssetError('INPUT_ASSET_PERSISTENCE', 'Could not persist the uploaded image', error); }
}
export function registerInputAssets(commands: CommandBus, fs: IFileSystem, readTask?: (ref: import('@itookit/tools/contracts').TaskAssetReference) => Promise<Uint8Array>): {dispose(): void} {
    const upload = commands.register(InputAssetCommand.Import, args => importInputAsset(fs, (args as {url: string}).url));
    const files = commands.register(InputAssetCommand.ImportFile, args => importInputFile(fs, args as import('@itookit/app-contracts').InputFileUpload));
    const inspect = commands.register(InputAssetCommand.Inspect, args => inspectInputFile(fs, args as import('@itookit/app-contracts').InputFileIdentity));
    const read = commands.register(InputAssetCommand.Read, async args => {
        const ref = (args as {reference: InputAssetReference | import('@itookit/tools/contracts').TaskAssetReference}).reference;
        if (!ref || !/^image\/(png|jpeg|webp)$/.test(ref.mimeType)) throw new Error('Invalid preview asset');
        const bytes = 'kind' in ref ? await readInputAsset(fs, ref) : await readTask?.(ref);
        if (!bytes) throw new Error('Asset preview is unavailable');
        return `data:${ref.mimeType};base64,${toBase64(bytes)}`;
    });
    return {dispose() {upload.dispose(); files.dispose(); inspect.dispose(); read.dispose();}};
}
function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
}

/** Normalize inline multimodal input before a Run or interaction is persisted. */
export async function stageInputAssets<T>(fs: IFileSystem, value: T): Promise<T> {
    if (Array.isArray(value)) {
        const staged = [];
        for (const item of value) staged.push(await stageInputAssets(fs, item));
        return staged as T;
    }
    if (!value || typeof value !== 'object') return value;
    const part = value as {type?: string; image_url?: {url?: string}};
    if (part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.startsWith('data:')) {
        return {type: 'image', source: {type: 'asset', asset: await importInputAsset(fs, part.image_url.url)}} as T;
    }
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await stageInputAssets(fs, item)]))) as T;
}
