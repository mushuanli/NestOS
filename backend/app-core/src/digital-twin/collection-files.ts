import {createFileSystemView, type IFileSystem} from '@itookit/vfs-core';
import {collectionExecutor, workspaceRoot, type TwinCollectionExecutor} from '@itookit/app-contracts';
import {createModuleLogger} from '@itookit/common';
import {createVFSToolContext} from '../vfs/tool-context';
const log = createModuleLogger('twin-scanner');

/** A saved scanner grants one application workspace, without exposing its project or the host root. */
export function acquireCollectionFiles(fs: IFileSystem, sessionId: string, executor: TwinCollectionExecutor, authorize: () => Promise<void>, projectRoot?: string) {
    const started = Date.now();
    const selected = collectionExecutor(executor), destination = selected?.destination;
    if (!destination && !(selected?.projectId && projectRoot)) throw new Error('TWIN_COLLECTION_DESTINATION_INVALID');
    const root = destination ? workspaceRoot(destination) : projectRoot!;
    const directory = selected?.directory ? root.replace(/\/$/, '') + '/' + selected.directory : root, view = createFileSystemView({viewId: `collection:${sessionId}`, mounts: [
        {mountId: 'destination', at: '/workspace', fs, root: directory, access: 'rw'},
    ]});
    const files = createVFSToolContext({fs: view, cwd: '/workspace', sessionId});
    const checked = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
        await checkAuthority(authorize, sessionId, directory); return call(...args);
    };
    log.info('twin.collection.files', {operationId: sessionId, sessionId,
        stage: 'destination.bind', result: 'success', destination: directory, mount: '/workspace', durationMs: Date.now() - started});
    return {cwd: '/workspace', release: () => view.dispose(), vfs: {
        readFile: checked(files.readFile), writeFile: checked(files.writeFile),
        readBinaryFile: checked(files.readBinaryFile!), writeBinaryFile: checked(files.writeBinaryFile!),
        listFiles: checked(files.listFiles), stat: checked(files.stat!),
        async *walkFiles(...args: Parameters<NonNullable<typeof files.walkFiles>>) {
            await checkAuthority(authorize, sessionId, directory);
            for await (const item of files.walkFiles!(...args)) {await checkAuthority(authorize, sessionId, directory); yield item;}
        },
    }};
}
async function checkAuthority(authorize: () => Promise<void>, sessionId: string, destination: string): Promise<void> {
    const started = Date.now();
    try {await authorize();}
    catch (error) {
        const message = error instanceof Error ? error.message : '';
        log.warn('twin.collection.files', {operationId: sessionId, sessionId, destination,
            stage: 'destination.authorize', result: 'failure', code: /^TWIN_[A-Z_]+$/.test(message) ? message : 'TWIN_COLLECTION_DESTINATION_DENIED',
            durationMs: Date.now() - started});
        throw error;
    }
}
