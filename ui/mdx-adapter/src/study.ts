import { StudyView, type StudyHost } from '@itookit/mdxeditor';
import { IEditor } from '@itookit/ui-common-adapter';
import type { IFileSystem } from '@itookit/vfs-core';
import { getLocale } from '@itookit/common';
import { createAdapterStore } from './srs-store';
import {createStudyPromptStore} from './study-prompt';
import {studyIndex} from './study-index';
import {createStudyDirectories} from './study-directories';

export function createStudyHost(fs: IFileSystem, open: (id: string) => Promise<void>, capabilities: Pick<StudyHost, 'creation'> = {}): StudyHost {
    const index = studyIndex(fs);
    return { ...capabilities, ...(capabilities.creation ? {creation: {...capabilities.creation,
        documents: {...capabilities.creation.documents, directories: capabilities.creation.documents.directories ?? createStudyDirectories(fs)},
        prompts: {...capabilities.creation.prompts, store: capabilities.creation.prompts?.store ?? createStudyPromptStore(fs)}}} : {}), locale: getLocale(), open, watch: notify => index.watch(notify),
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
    async activate(): Promise<void> { await this.view?.refresh(); }
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
export async function createStudyEditor(container: HTMLElement, fs: IFileSystem, open: (id: string) => Promise<void>, capabilities: Pick<StudyHost, 'creation'> = {}): Promise<IEditor> {
    const editor = new StudyEditor(createStudyHost(fs, open, capabilities)); await editor.init(container); return editor;
}
