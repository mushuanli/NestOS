import {createModuleLogger, t} from '@itookit/common';
import {MDxController} from '../mdx/MDxController';

interface DocumentView {element: HTMLDetailsElement; body: HTMLElement; editor: MDxController; text: string}

/** Stable per-document editors survive run refreshes; collapsed documents render on demand. */
export class FlowDocuments {
    private views = new Map<string, DocumentView>();
    mount(target: HTMLElement, key: string, title: string, text: string, initiallyOpen = text.length < 4000): void {
        let view = this.views.get(key);
        if (!view) {view = this.create(key, title, text, initiallyOpen); this.views.set(key, view);}
        view.element.querySelector('summary')!.textContent = title;
        if (view.text !== text) {view.text = text; view.editor.setContent(text);}
        target.append(view.element);
    }
    private create(key: string, title: string, text: string, initiallyOpen: boolean): DocumentView {
        const element = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('div');
        element.className = 'flow-document'; body.className = 'flow-document__body';
        summary.textContent = title; element.append(summary, body); element.open = initiallyOpen;
        const mount = document.createElement('div'); mount.className = 'flow-document__editor'; body.append(mount);
        const editor = new MDxController(mount, text, {deferred: true, editable: false, readOnly: true});
        const activate = () => {
            if (!element.open) return;
            const started = Date.now();
            void editor.waitUntilReady().catch(() => {
                if (!this.views.has(key)) return;
                body.textContent = t('flow.document.failed');
                createModuleLogger('flow-document').warn('flow.document.render', {operationId: key, stage: 'render',
                    result: 'failure', code: 'FLOW_DOCUMENT_RENDER_FAILED', durationMs: Date.now() - started});
            });
        };
        element.addEventListener('toggle', activate);
        if (element.open) queueMicrotask(activate);
        return {element, body, editor, text};
    }
    retain(keys: ReadonlySet<string>): void {
        for (const [key, view] of this.views) if (!keys.has(key)) {
            this.views.delete(key); view.element.remove(); void view.editor.destroy();
        }
    }
    destroy(): void {this.retain(new Set());}
}

export function flowRequestMarkdown(value: unknown): string {
    const text = JSON.stringify(value ?? {}, null, 2);
    const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
    return `${fence}json\n${text}\n${fence}`;
}
