import type {IFileSystem} from '@itookit/vfs-core';

export interface EditorSwapSnapshot {content: string; savedAt: number;}
/** One editor owns one opaque file; a disconnected capability does not delete crash recovery data. */
export interface EditorSwap {
    writeSwap(content: string): Promise<void>;
    readSwap(): Promise<EditorSwapSnapshot | undefined>;
    clearSwap(): Promise<void>;
    closeSwap(): Promise<void>;
    dispose(): Promise<void>;
}
export interface EditorSwapFactory {
    openEditorSwap(request: {files: IFileSystem; path: string}): Promise<EditorSwap>;
}
/** Trusted host storage, never exported as a capability. */
export interface EditorSwapStore {
    open(document: {namespaceId: string; path: string}): EditorSwap;
}
