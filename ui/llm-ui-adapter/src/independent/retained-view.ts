import {createModuleLogger, randomUUID} from '@itookit/common';
import type {ChatBinding, ChatView, ComposerDraft} from '@itookit/llm-ui';

export interface ViewBinding {
    readonly options: ChatBinding;
    setActive?(active: boolean): void;
    release?(): void | Promise<void>;
}
/** Own adapter presentation hooks across rebindings; never close a shared source or task. */
export function retainViewBindings(view: ChatView, initial: ViewBinding) {return new RetainedViewBindings(view, initial);}
class RetainedViewBindings {
    private active = true;
    private closing?: Promise<void>;
    private releases = new Set<Promise<void>>();
    private failures: unknown[] = [];
    private readonly apply: ChatView['replaceBinding'];
    private readonly destroyView: ChatView['destroy'];
    constructor(readonly view: ChatView, private current: ViewBinding) {
        this.apply = view.replaceBinding.bind(view); this.destroyView = view.destroy.bind(view);
        const setActive = view.setActive.bind(view);
        view.replaceBinding = (options, replacement) => this.replace({options}, replacement?.draft);
        view.setActive = value => {if (!this.closing) {this.active = value; this.activate(this.current, value); setActive(value);}};
        view.destroy = () => this.closing ??= this.destroy();
    }
    replace = async (next: ViewBinding, draft?: ComposerDraft): Promise<void> => {
        let committed = false;
        try {await this.apply(next.options, {draft}); committed = true;}
        catch (error) {committed = !!(error as {bindingCommitted?: boolean})?.bindingCommitted; throw error;}
        finally {
            if (committed) {
                const previous = this.current; this.current = next;
                this.activate(previous, false); void this.retire(previous); this.activate(next, this.active);
            } else await this.retire(next);
        }
    };
    private activate(binding: ViewBinding, active: boolean): void {
        try {binding.setActive?.(active);} catch (error) {this.report('activation', Date.now(), error);}
    }
    private retire(binding: ViewBinding): Promise<void> {
        const started = Date.now();
        const task = Promise.resolve().then(() => binding.release?.()).catch(error => this.report('release', started, error));
        this.releases.add(task); void task.then(() => this.releases.delete(task)); return task;
    }
    private report(stage: string, started: number, error: unknown): void {
        this.failures.push(error);
        try {createModuleLogger('chat-binding').warn('chat.binding.cleanup', {operationId: randomUUID(), stage, result: 'failure',
            code: 'BINDING_CLEANUP_FAILED', durationMs: Date.now() - started});} catch { /* Cleanup cannot depend on diagnostics. */ }
    }
    private async destroy(): Promise<void> {
        this.activate(this.current, false); void this.retire(this.current);
        try {await this.destroyView();} finally {await Promise.all(this.releases);}
        if (this.failures.length) throw new AggregateError(this.failures, 'Chat binding cleanup failed');
    }
}
