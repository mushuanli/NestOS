import {createModuleLogger, randomUUID, t} from '@itookit/common';
import type {ApplicationBackend, EditorSwap} from '@itookit/app-contracts/services';
import type {EditorFactory} from '@itookit/ui-common';
import {canPreserveRefreshBackup} from '../persistence/file-recovery-store';

const log = createModuleLogger('editor-swap');
/** Optional HTTP-only capability: ordinary Web/Tauri editors allocate no swap, timer or menu action. */
export function createEditorSwapFactory(factory: EditorFactory, backend: ApplicationBackend): EditorFactory {
    const swaps = backend.editorSwaps;
    if (!swaps) return factory;
    return async (container, options) => {
        if (options.target?.kind !== 'file' || !options.files?.fs || !options.hostContext || options.readOnly || options.hostContext.reloadRecovery) return factory(container, options);
        const files = options.files.fs; let path = options.target.path, lease: Promise<EditorSwap> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined, closed = false, retained = false, tail = Promise.resolve();
        const operationId = randomUUID();
        const get = () => lease ??= swaps.openEditorSwap({files, path}).catch(error => {lease = undefined; throw error;});
        const failure = (error: unknown) => {
            const code = (error as {code?: unknown})?.code, category = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'EDITOR_SWAP_FAILED';
            log.warn('editor.swap', {operation: 'editor.swap', operationId, stage: 'persist', result: 'failure', code: category});
            if (closed) return;
            let status = container.querySelector<HTMLElement>('[data-editor-swap-error]');
            if (!status) {status = document.createElement('p'); status.dataset.editorSwapError = ''; status.setAttribute('role', 'status'); container.append(status);}
            status.textContent = t('editor.file.swapFailed', {code: category});
        };
        const write = (content: string): Promise<void> => {
            if (closed) return Promise.resolve();
            const next = tail.then(async () => {
                if (canPreserveRefreshBackup(content)) {retained = true; await (await get()).writeSwap(content);}
                else if (lease && retained) {await (await lease).clearSwap(); retained = false;}
                container.querySelector('[data-editor-swap-error]')?.remove();
            });
            tail = next.catch(failure); return next;
        };
        const editor = await factory(container, {...options, hostContext: {...options.hostContext, reloadRecovery: {
            canPreserve: canPreserveRefreshBackup,
            preserve: async content => {if (timer) clearTimeout(timer); timer = undefined; await write(content);},
            read: async () => {await tail; return lease ? (await lease).readSwap() : undefined;},
        }}});
        if (typeof editor.on !== 'function') return editor;
        const stop = editor.on('change', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {timer = undefined; if (!closed) void write(editor.getText()).catch(() => {});}, 500);
        });
        const rename = editor.updateNodeId?.bind(editor);
        if (rename) editor.updateNodeId = next => {rename(next); path = next;};
        const destroy = editor.destroy.bind(editor);
        editor.destroy = async () => {
            if (closed) return;
            closed = true; if (timer) clearTimeout(timer); stop();
            try {await destroy();}
            finally {await tail; if (lease) try {await (await lease).closeSwap();} catch (error) {failure(error);}}
        };
        return editor;
    };
}
