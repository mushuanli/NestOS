import { createMDXFile, guessMimeType, type IFileSystem } from '@itookit/vfs-core';
import type { AssetProvider } from '@itookit/mdxeditor';

/** Reject traversal before forwarding a relative attachment name to a granted view. */
function assetName(name: string): string {
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('Invalid attachment name');
    }
    return name;
}

export function createAssetProvider(fs?: IFileSystem, documentPath: () => string | undefined = () => undefined,
    assets?: IFileSystem): AssetProvider | undefined {
    if (!assets && (!fs || !documentPath())) return undefined;
    return {
        read: name => assets ? assets.driver.readContent('/' + assetName(name), { encoding: 'binary' }) as Promise<ArrayBuffer>
            : createMDXFile(fs!, documentPath()!).asset(assetName(name)).read(),
        upload: async (name, content) => {
            const node = assets ? await assets.driver.createFile({ parentPath: '/', name: assetName(name), content })
                : await fs!.meta.assets.putAsset(documentPath()!, assetName(name), content);
            return { name: node.name };
        },
        prune: () => fs && documentPath() ? createMDXFile(fs, documentPath()!).pruneUnusedAssets() : Promise.resolve(0),
        mimeType: guessMimeType,
    };
}
