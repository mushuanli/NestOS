import { StudyView, type StudyHost } from '@itookit/mdxeditor';
import { IEditor } from '@itookit/ui-common';
import type { IFileSystem } from '@itookit/vfs-core';
import { getLocale } from '@itookit/common';
import { createAdapterStore } from './srs-store';
import {studyIndex} from './study-index';

export function createStudyHost(fs: IFileSystem, open: (id: string) => Promise<void>): StudyHost {
    const index = studyIndex(fs);
    return {locale: getLocale(), open, watch: notify => index.watch(notify),
        list: parent => index.list(parent), read: id => index.read(id),
        store: id => index.store(id, createAdapterStore(fs, id, 'cloze:memory')),
    };
}
class StudyEditor extends IEditor {
    readonly commands = {};
    private view?: StudyView;
    constructor(private host: StudyHost) { super(); }
    async init(container: HTMLElement): Promise<void> { this.view = new StudyView(container, this.host); }
    async destroy(): Promise<void> { await this.view?.destroy(); }
    async flushPendingSave(): Promise<void> { await this.view?.flush(); }
    getText(): string { return ''; }
    setText(): void {}
    focus(): void {}
    getMode(): 'render' { return 'render'; }
    async switchToMode(): Promise<void> {}
    setTitle(): void {}
    setReadOnly(): void {}
    isDirty(): boolean { return false; }
    setDirty(): void {}
    async navigateTo(): Promise<void> {}
    async search(): Promise<[]> { return []; }
    gotoMatch(): void {}
    clearSearch(): void {}
    on(): () => void { return () => {}; }
}
export async function createStudyEditor(container: HTMLElement, fs: IFileSystem, open: (id: string) => Promise<void>): Promise<IEditor> {
    const editor = new StudyEditor(createStudyHost(fs, open)); await editor.init(container); return editor;
}
