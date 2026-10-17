import { AssetResolverPlugin, MDxRenderer } from '@itookit/mdxeditor';
import type { ChatOptions, MessagePart, MountedRenderer, RenderContext } from './contracts';
import { element, errorText } from './dom';
import { markdownOptions } from './content-policy';
import type { Translate } from './i18n';

/** One renderer per stable part, with serialized updates and an abortable lifetime. */
export class PartView {
    readonly element = element('div', 'llm-chat__part');
    private readonly abort = new AbortController();
    private markdown?: MDxRenderer;
    private extension?: MountedRenderer;
    private tail = Promise.resolve();
    private content?: HTMLElement;
    private disposed?: Promise<void>;
    constructor(private readonly options: ChatOptions, private readonly t: Translate,
        private readonly rendered: () => void) {}
    update(part: MessagePart, context: RenderContext): void {
        this.tail = this.tail.catch(() => {}).then(async () => {
            if (this.abort.signal.aborted) return;
            try { await this.render(part, context); }
            catch (error) {
                if (this.abort.signal.aborted) return;
                this.element.textContent = errorText(error); this.options.onError?.(error);
            }
            if (!this.abort.signal.aborted) this.rendered();
        });
    }
    private async render(part: MessagePart, context: RenderContext): Promise<void> {
        if (part.kind === 'markdown' || part.kind === 'reasoning') return this.renderMarkdown(part, context);
        if (part.kind === 'extension') return this.renderExtension(part, context);
        if (part.kind === 'tool') {
            const details = element('details');
            details.append(element('summary', undefined, `${part.name}: ${part.summary}`), element('pre', undefined, part.detail ?? ''));
            details.dataset.state = part.state; this.element.replaceChildren(details);
        } else if (part.kind === 'attachment') {
            const file = element('a', undefined, part.file.name); file.href = '#';
            file.addEventListener('click', event => {
                event.preventDefault(); void this.options.onOpenResource?.(part.file.id).catch(this.options.onError ?? (() => {}));
            });
            this.element.replaceChildren(file);
        }
    }
    private async renderMarkdown(part: Extract<MessagePart, { kind: 'markdown' | 'reasoning' }>, context: RenderContext): Promise<void> {
        if (!this.markdown) {
            this.markdown = new MDxRenderer({ htmlPolicy: 'literal', assets: this.options.assets, signal: this.abort.signal });
            this.markdown.markedExtensions.push(markdownOptions.markedOptions);
            this.markdown.usePlugin(new AssetResolverPlugin());
            this.content = element('div');
            if (part.kind === 'reasoning') {
                const details = element('details'); details.append(element('summary', undefined, this.t('reasoning')), this.content);
                this.element.append(details);
            } else this.element.append(this.content);
        }
        if (context.message.state === 'streaming') await this.markdown.renderStreaming(this.content!, part.text);
        else await this.markdown.render(this.content!, part.text, markdownOptions);
    }
    private async renderExtension(part: Extract<MessagePart, { kind: 'extension' }>, context: RenderContext): Promise<void> {
        const factory = this.options.renderers?.[part.type];
        if (!factory) { this.element.textContent = `${this.t('unsupported')}: ${part.type}`; return; }
        if (!this.extension) this.extension = factory(this.element, part, context);
        else await this.extension.update?.(part, context);
    }
    destroy(): Promise<void> {
        if (this.disposed) return this.disposed;
        this.abort.abort();
        return this.disposed = this.tail.finally(async () => {
            try { this.markdown?.destroy(); } finally { await this.extension?.destroy(); }
        });
    }
}
