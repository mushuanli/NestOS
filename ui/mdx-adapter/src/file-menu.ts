import {compareFileContents} from './file-compare';
import {ACTION_ICONS, FILE_BROWSER_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import type {MDxEditor} from '@itookit/mdxeditor';
import type {EditorOptions} from '@itookit/ui-common';

const log = createModuleLogger('file-menu');
/** Read file details only when requested; explicit reload never writes or replaces a dirty draft. */
export function mountFileMenu(container: HTMLElement, editor: MDxEditor, options: EditorOptions, getPath: () => string | undefined): () => void {
    const fs = options.files?.fs;
    if (options.target?.kind !== 'file' || !fs) return () => {};
    const lifetime = new AbortController(); let busy = false, generation = 0;
    container.dataset.mdxMenuKeepOpen = '';
    const info = document.createElement('details'), summary = document.createElement('summary');
    info.className = 'mdx-file-menu__info'; info.dataset.fileInfo = ''; info.dataset.mdxMenuKeepOpen = '';
    summary.innerHTML = ACTION_ICONS.info; summary.title = t('editor.file.info'); summary.setAttribute('aria-label', summary.title);
    summary.className = 'mdx-file-menu__icon';
    const values = document.createElement('dl'), status = document.createElement('p'); status.setAttribute('role', 'status');
    info.append(summary, values); container.append(info);
    const report = (action: string, operationId: string, started: number, error?: unknown) => {
        const code = (error as {code?: string})?.code;
        const data = {operation: 'file.' + action, operationId, stage: action, result: error ? 'failure' : 'success',
            durationMs: Date.now() - started, ...(error ? {code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FILE_READ_FAILED'} : {})};
        if (error) log.warn('file.menu', data); else log.info('file.menu', data);
    };
    const details = async () => {
        const path = getPath(), read = ++generation, operationId = randomUUID(), started = Date.now(); if (!path) return;
        try {
            const node = await fs.driver.getNode(path);
            if (lifetime.signal.aborted || read !== generation || path !== getPath()) return;
            if (!node) throw Object.assign(new Error(t('editor.file.missing')), {code: 'ENOENT'});
            values.replaceChildren();
            for (const [label, value] of [[t('editor.file.created'), node.createdAt], [t('editor.file.modified'), node.modifiedAt]] as const) {
                const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label;
                description.textContent = Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : t('editor.file.unknown'); values.append(term, description);
            }
            status.textContent = ''; report('info', operationId, started);
        } catch (error) {if (!lifetime.signal.aborted && read === generation) {status.textContent = error instanceof Error ? error.message : t('editor.file.failed'); report('info', operationId, started, error);}}
    };
    info.addEventListener('toggle', () => {if (info.open) void details();}, {signal: lifetime.signal});
    const reload = options.hostContext?.reloadContent;
    if (reload) {
        const refresh = document.createElement('button'); refresh.type = 'button'; refresh.dataset.fileRefresh = '';
        refresh.dataset.mdxMenuKeepOpen = '';
        refresh.className = 'mdx-editor-titlebar__button mdx-file-menu__icon'; refresh.innerHTML = FILE_BROWSER_ICONS.refresh;
        refresh.title = t('editor.file.refresh'); refresh.setAttribute('aria-label', refresh.title);
        container.append(refresh);
        refresh.addEventListener('click', async () => {
            if (busy || lifetime.signal.aborted) return;
            const path = getPath(), original = editor.getText(), operationId = randomUUID(), started = Date.now(); if (!path) return;
            const dirty = editor.isDirty(); let accepted = false;
            busy = true; refresh.disabled = true; status.textContent = t('editor.file.refreshing');
            try {
                await reload(path, async content => {
                    if (lifetime.signal.aborted || path !== getPath() || editor.isDirty() !== dirty || editor.getText() !== original)
                        throw Object.assign(new Error(t('editor.file.changed')), {code: 'ECONFLICT'});
                    if (content !== original) {
                        const recovery = options.hostContext?.reloadRecovery, preserve = recovery?.canPreserve?.(original) ?? !!recovery;
                        if (!await compareFileContents(original, content, dirty, lifetime.signal, true, undefined, dirty && !preserve ? recovery ? 'large' : 'disabled' : false)) return false;
                        if (lifetime.signal.aborted || path !== getPath() || editor.getText() !== original || editor.isDirty() !== dirty)
                            throw Object.assign(new Error(t('editor.file.changed')), {code: 'ECONFLICT'});
                        if (dirty && preserve) try {await options.hostContext!.reloadRecovery!.preserve(original);}
                        catch (error) {throw Object.assign(new Error(t('editor.file.backupFailed'), {cause: error}), {code: 'RELOAD_BACKUP_FAILED'});}
                    }
                    editor.replaceLoadedContent(content, original); accepted = true; return true;
                });
                if (!lifetime.signal.aborted) {status.textContent = t(accepted ? 'editor.file.refreshed' : 'editor.file.kept'); if (accepted && info.open) await details();}
                report('refresh', operationId, started);
            } catch (error) {if (!lifetime.signal.aborted) {status.textContent = error instanceof Error ? error.message : t('editor.file.failed'); report('refresh', operationId, started, error);}}
            finally {busy = false; refresh.disabled = false;}
        }, {signal: lifetime.signal});
    }
    if (options.hostContext?.reloadRecovery) {
        const backup = document.createElement('button'); backup.type = 'button'; backup.textContent = t('editor.file.backup');
        backup.onclick = async () => {
            const operationId = randomUUID(), started = Date.now();
            try {
                const content = await options.hostContext!.reloadRecovery!.read();
                if (!lifetime.signal.aborted) {
                    if (content === undefined) status.textContent = t('editor.file.noBackup');
                    else void compareFileContents(typeof content === 'string' ? content : content.content, editor.getText(), false, lifetime.signal, false,
                        {savedAt: typeof content === 'string' ? undefined : content.savedAt});
                }
                report('backup', operationId, started);
            } catch (error) {if (!lifetime.signal.aborted) {status.textContent = t('editor.file.backupFailed'); report('backup', operationId, started, error);}}
        }; info.append(backup);
    }
    container.append(status); return () => {lifetime.abort(); ++generation;};
}
