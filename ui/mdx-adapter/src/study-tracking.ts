import type {MDxPlugin, PluginContext} from '@itookit/mdxeditor';
import type {IFileSystem} from '@itookit/vfs-core';
import {createModuleLogger, randomUUID} from '@itookit/common';
import {studyIndex} from './study-index';

/** Register only documents whose cloze syntax has actually rendered. */
export class StudyTrackingPlugin implements MDxPlugin {
    readonly name = 'host:study-tracking';
    private stops: Array<() => void> = [];
    private release?: () => void;
    private path?: string;
    private root?: HTMLElement;
    constructor(private readonly fs: IFileSystem) {}
    install(context: PluginContext): void {
        this.stops.push(context.on('domUpdated', ({element}: {element: HTMLElement}) => {
            const path = context.getDocumentPath(); if (!path || !element.querySelector('[data-cloze-locator]')) return;
            this.root = element;
            if (this.path !== path) {this.release?.(); this.path = path; this.release = studyIndex(this.fs).acquire(path,
                () => !!this.root?.isConnected && !this.root.closest('[hidden]') && !document.hidden);}
            void studyIndex(this.fs).update(path, true).catch(error => {
                const code = (error as {code?: string})?.code;
                createModuleLogger('study-tracking').warn('study.track', {operationId: randomUUID(), stage: 'register', result: 'failure', code: code && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'CLOZE_TRACK_FAILED'});
            });
        }));
    }
    destroy(): void {this.stops.splice(0).forEach(stop => stop()); this.release?.(); this.release = undefined;}
}
