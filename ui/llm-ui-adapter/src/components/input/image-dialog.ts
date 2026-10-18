import {getLocale, t} from '@itookit/common';
import type {ImageEditItem, ImageProcessor, ImageResizePolicy, PreparedImage} from '@itookit/image-parser';

interface Options {items: readonly ImageEditItem[]; activeId: string; processor: ImageProcessor; resize: ImageResizePolicy;
    signal: AbortSignal; own(close: () => void): void;
    save(changes: readonly PreparedImage[], resize: ImageResizePolicy): Promise<void>}
function dialogElements() {
    const dialog = document.createElement('dialog'); dialog.className = 'llm-image-dialog';
    const header = document.createElement('header'), title = document.createElement('strong'), host = document.createElement('div'), error = document.createElement('p');
    title.textContent = t('image.title'); header.append(title); host.className = 'llm-image-dialog__content'; error.setAttribute('role', 'status');
    const cancel = document.createElement('button'), apply = document.createElement('button'), done = document.createElement('button');
    cancel.type = apply.type = done.type = 'button'; cancel.textContent = t('image.cancel');
    apply.textContent = t('image.apply'); apply.title = t('image.applyHint'); apply.dataset.action = 'apply-image';
    done.textContent = t('image.done'); done.title = t('image.doneHint'); done.dataset.action = 'finish-images'; header.append(cancel, apply, done);
    dialog.append(header, host, error); dialog.setAttribute('aria-label', t('image.title'));
    return {dialog, host, error, cancel, apply, done};
}
interface Actions {changed(): boolean; close(): void; apply(): Promise<void>; finish(): Promise<void>; active(): boolean}
function bindActions({dialog, host, error, cancel, apply, done}: ReturnType<typeof dialogElements>, actions: Actions): void {
    let working = false;
    const requestClose = () => {if (!working && (!actions.changed() || window.confirm(t('image.discard')))) actions.close();};
    cancel.addEventListener('click', requestClose);
    dialog.addEventListener('cancel', event => {event.preventDefault(); requestClose();});
    const perform = async (finish: boolean) => {
        if (working) return; working = true; host.inert = true; done.disabled = apply.disabled = cancel.disabled = true; error.textContent = '';
        try {if (finish) await actions.finish(); else await actions.apply();}
        catch (failure) {if (actions.active()) error.textContent = failure instanceof Error ? failure.message : String(failure);}
        finally {working = false; host.inert = false; done.disabled = apply.disabled = cancel.disabled = false;}
    };
    apply.addEventListener('click', () => {void perform(false);});
    done.addEventListener('click', () => {void perform(true);});
}
/** The host owns modal focus and durable handoff; the library owns only its panel. */
export async function openImageDialog(options: Options): Promise<void> {
    const {createImageEditor} = await import('@itookit/image-parser/ui'); options.signal.throwIfAborted();
    const {dialog, host, error, cancel, apply, done} = dialogElements(); document.body.append(dialog);
    const focus = document.activeElement as HTMLElement | null, task = new AbortController();
    let resize = options.resize, changed = false, settled = false;
    const editor = createImageEditor(host, {...options, locale: getLocale(),
        onChange: () => {changed = true;}, onResize: value => {resize = value; changed = true;}});
    let resolve!: () => void;
    const promise = new Promise<void>(finish => {resolve = finish;});
    const close = () => {if (settled) return; settled = true; task.abort(); options.signal.removeEventListener('abort', close);
        void editor.destroy().catch(failure => {console.error('[Image editor cleanup]', failure);})
            .finally(() => {dialog.remove(); focus?.focus(); resolve();});};
    options.own(close); options.signal.addEventListener('abort', close, {once: true});
    bindActions({dialog, host, error, cancel, apply, done}, {
        changed: () => changed, close,
        apply: () => editor.apply({signal: task.signal}),
        finish: async () => {const prepared = await editor.prepare({signal: task.signal}); task.signal.throwIfAborted(); await options.save(prepared, resize); close();},
        active: () => !settled,
    });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    done.focus(); await promise;
}
