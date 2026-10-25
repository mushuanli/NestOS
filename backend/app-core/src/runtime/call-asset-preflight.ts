import type {IFileSystem} from '@itookit/vfs-core';
import {inputAssetError, readInputAsset} from './input-asset-store';
import type {InputAssetReference} from '@itookit/tools/contracts';

/** Validate declared material blocks only; arbitrary business JSON is not an asset capability. */
export async function validateCallAssets(fs: IFileSystem, value: unknown): Promise<void> {
    const checked = new Set<string>();
    const visit = async (item: unknown, depth: number): Promise<void> => {
        if (!item || typeof item !== 'object') return;
        if (depth > 64) throw inputAssetError('INPUT_ASSET_DEPTH', 'Input materials exceed the nesting limit');
        const ref = materialReference(item);
        if (ref) {
            const key = JSON.stringify(ref);
            if (!checked.has(key)) {await verifyAsset(fs, ref); checked.add(key);}
            return;
        }
        for (const child of Array.isArray(item) ? item : Object.values(item)) await visit(child, depth + 1);
    };
    await visit(value, 0);
}
function materialReference(item: object): InputAssetReference | undefined {
    const part = item as {type?: string; source?: {type?: string; asset?: InputAssetReference}};
    if (!['file', 'image'].includes(part.type ?? '') || part.source?.type !== 'asset') return;
    const ref = part.source.asset;
    if (ref?.kind !== 'input') throw inputAssetError('ASSET_INPUT_TRANSFER_REQUIRED', 'Task files must be explicitly imported before a new invocation');
    return ref;
}
async function verifyAsset(fs: IFileSystem, ref: InputAssetReference): Promise<void> {
    try {await readInputAsset(fs, ref);}
    catch (error) {
        const code = (error as {code?: unknown})?.code;
        if (typeof code === 'string' && /^INPUT_ASSET_[A-Z_]+$/.test(code)) throw error;
        const denied = code === 'EACCES' || code === 'EPERM';
        throw inputAssetError(denied ? 'INPUT_ASSET_STORAGE_DENIED' : 'INPUT_ASSET_READ_FAILED',
            denied ? 'Input asset storage access was denied' : 'Could not verify the selected input asset', error);
    }
}
