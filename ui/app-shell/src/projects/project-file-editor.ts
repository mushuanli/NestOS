import {createRecoverableFileEditor} from '../browser/file-recovery';
import { PROJECT_EDITOR_MAX_BYTES, showLargeFilePreview } from './large-file-preview';
import type { ProjectService } from '@itookit/app-contracts/services';
import { buildRenamedFilename, traceBoot, t } from '@itookit/common';
import type { EditorFactory, EditorHostContext, EditorOptions, IEditor } from '@itookit/ui-common';
import { FSError, type FSNode, type FileSystemContextOwner } from '@itookit/vfs-core';
import { fileContentFormat } from '../browser/file-format';
import { ViewLoad, ViewLoadCancelled } from '../lifecycle/view-load';

interface ProjectFileOptions {
    factory: EditorFactory;
    mount(): Promise<HTMLElement>;
    showBinary(mount: HTMLElement, path: string, bytes: ArrayBuffer): () => void;
    deferCleanup(cleanup: Promise<void>): void;
    changed(): void;
    host: EditorHostContext;
    recoveryScope?: string;
    mountWindowList?: EditorOptions['mountWindowList'];
}
interface OpenedProjectFile { node: FSNode; editor?: IEditor; context: FileSystemContextOwner; previewCleanup?: () => void }

export async function openProjectFileEditor(projects: ProjectService, target: { folder: string; path: string },
    load: ViewLoad, options: ProjectFileOptions): Promise<OpenedProjectFile> {
    let owner: Awaited<ReturnType<ProjectService['openWorkspace']>> | undefined;
    let editor: IEditor | undefined;
    let mount: HTMLElement | undefined;
    let previewCleanup: (() => void) | undefined;
    try {
        const source = await load.read(async () => owner = await traceBoot('projectFile.source', () => projects.openWorkspace(target.folder)));
        const context: FileSystemContextOwner = { context: { fs: source.fs, cwd: target.path.slice(0, target.path.lastIndexOf('/')) || '/' }, release: () => source.dispose() };
        const driver = source.fs.driver;
        const node = await load.read(() => traceBoot('projectFile.type', () => driver.getNode(target.path, { signal: load.signal })));
        if (!node) throw new FSError('ENOENT', 'File not found');
        if (node.type === 'directory') return {node, context};
        mount = await options.mount(); load.check();
        const large = async () => {
            previewCleanup = await showLargeFilePreview(context, target.path, node.type === 'file' ? node.size : undefined, mount!, load);
            return { node, context, previewCleanup };
        };
        if (node.type === 'file' && node.size !== undefined && node.size > PROJECT_EDITOR_MAX_BYTES) return await large();
        let revision: string | undefined;
        let bytes: ArrayBuffer;
        try { bytes = await load.read(() => traceBoot('projectFile.read', () => driver.readContent(target.path, { encoding: 'binary', signal: load.signal, onRevision: value => { revision = value; } }))); }
        catch (error) { if (error instanceof FSError && error.code === 'EFBIG') return await large(); throw error; }
        const content = decodeFile(target.path, bytes);
        if (content === undefined) previewCleanup = options.showBinary(mount, target.path, bytes);
        else editor = await load.read(async () => editor = await createTextEditor(context, target.path, content, mount!, load, options, revision));
        load.check();
        return { node, editor, context, previewCleanup };
    } catch (error) {
        mount?.remove();
        const cleanup = load.drain().then(async () => { await editor?.destroy(); previewCleanup?.(); await owner?.dispose(); });
        if (error instanceof ViewLoadCancelled) options.deferCleanup(cleanup); else await cleanup;
        throw error;
    }
}

function decodeFile(path: string, bytes: ArrayBuffer): string | undefined {
    if (/\.(pdf|zip|gz|tar|7z|rar|png|jpe?g|gif|webp|avif|ico|mp[34]|wav|ogg|webm|mov|woff2?|ttf|bin|sqlite|db|docx?|xlsx?|pptx?)$/i.test(path)) return;
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!text.includes('\0')) return text; }
    catch { /* Binary files are previewed or downloaded. */ }
}

async function createTextEditor(context: FileSystemContextOwner, path: string, content: string,
    mount: HTMLElement, load: ViewLoad, options: ProjectFileOptions, revision?: string): Promise<IEditor> {
    const { fs } = context.context;
    const readOnly = (await fs.capabilitiesAt(path)).readonly;
    load.check();
    const filename = path.split('/').pop()!;
    return traceBoot('projectFile.editor', () => createRecoverableFileEditor(options.factory, mount, {
        ...fileContentFormat(path), target: { kind: 'file', path }, files: context.context,
        mountWindowList: options.mountWindowList,
        initialContent: content, readOnly, signal: load.signal, title: buildRenamedFilename(filename, filename).title,
        hostContext: { ...options.host,
            reloadContent: async (file, accept) => {
                let nextRevision: string | undefined;
                const bytes = await fs.driver.readContent(file, {encoding: 'binary', onRevision: value => {nextRevision = value;}});
                if (await accept(new TextDecoder().decode(bytes))) revision = nextRevision;
            },
            saveContent: readOnly ? undefined : async (file, text) => {
                try {
                    await fs.driver.writeContent(file, text, { ifRevision: revision, onRevision: value => { revision = value; } }); options.changed();
                } catch (error) {
                    throw localizeRemoteWriteError(error);
                }
            },
        },
    }, options.recoveryScope ?? context.context.fs.viewId));
}

export function localizeRemoteWriteError(error: unknown): unknown {
    const receipt = error as { code?: string; outcome?: string; operationId?: string };
    if (receipt.outcome === 'unknown') return new Error(`${t('remote.writeUnknown')} ${receipt.operationId ?? ''}`);
    return receipt.code === 'ECONFLICT' ? new Error(t('remote.writeConflict')) : error;
}
