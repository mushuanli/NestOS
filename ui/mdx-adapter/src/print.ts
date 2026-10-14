import { DefaultPrintService as StandalonePrintService } from '@itookit/mdxeditor';
import type { IFileSystem } from '@itookit/vfs-core';
import { createAssetProvider } from './assets';

export class DefaultPrintService extends StandalonePrintService {
    constructor(fs?: IFileSystem, path?: string, assets?: IFileSystem) {
        super({ documentPath: path, assets: createAssetProvider(fs, () => path, assets) });
    }
}
