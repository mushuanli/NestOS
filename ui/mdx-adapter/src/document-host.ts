import { buildRenamedFilename } from '@itookit/common';
import { Toast, type EditorOptions } from '@itookit/ui-common';
import type { EditorHost } from '@itookit/mdxeditor';
import type { IFileSystem } from '@itookit/vfs-core';

/** Keep filename suffix and stored-title semantics in the VFS integration. */
export async function renameDocument(fs: IFileSystem, path: string, requested: string): Promise<{ path: string; title: string }> {
    const { filename, title } = buildRenamedFilename(requested, path.slice(path.lastIndexOf('/') + 1));
    const node = await fs.driver.getNode(path);
    const oldTitle = typeof node?.metadata?.title === 'string' ? node.metadata.title : null;
    if (oldTitle !== null) await fs.driver.updateMetadata(path, { title });
    try { await fs.driver.rename(path, filename); }
    catch (error) {
        if (oldTitle !== null) await fs.driver.updateMetadata(path, { title: oldTitle }).catch(() => {});
        throw error;
    }
    return { path: path.slice(0, path.lastIndexOf('/') + 1) + filename, title };
}

export function createDocumentHost(options: EditorOptions): EditorHost {
    return {
        openDocument: options.hostContext?.openFile,
        renameDocument: options.files ? (path, title) => renameDocument(options.files!.fs, path, title) : undefined,
        notify: (message, level) => Toast[level](message),
    };
}
