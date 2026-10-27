import {t} from '@itookit/common';

/** Linear comparison: mark the changed interval, preserving every line for inspection. */
function pane(label: string, text: string, start: number, end: number): HTMLElement {
    const section = document.createElement('section'), heading = document.createElement('h3'), pre = document.createElement('pre');
    heading.textContent = label; pre.tabIndex = 0;
    const lines = text.split('\n');
    const numbered = (from: number, to: number) => lines.slice(from, to).map((line, index) => `${from + index + 1}  ${line}\n`).join('');
    const changed = document.createElement('span'); changed.dataset.changed = ''; changed.textContent = numbered(start, end);
    pre.append(document.createTextNode(numbered(0, start)), changed, document.createTextNode(numbered(end, lines.length)));
    section.append(heading, pre); return section;
}
export function compareFileContents(current: string, incoming: string, dirty: boolean, signal: AbortSignal, confirm: boolean, backup?: {savedAt?: number}, withoutBackup: false | 'large' | 'disabled' = false): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const a = current.split('\n'), b = incoming.split('\n'); let start = 0, tail = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
    while (tail < Math.min(a.length, b.length) - start && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
    return new Promise(resolve => {
        const dialog = document.createElement('dialog'); dialog.className = 'mdx-file-compare';
        const title = document.createElement('h2'); title.textContent = t(backup ? 'editor.file.backup' : 'editor.file.compare');
        const hint = document.createElement('p'); hint.textContent = t(dirty ? confirm ? 'editor.file.compareDirty' : 'editor.file.compareUnsafe' : 'editor.file.compareHint');
        if (withoutBackup) hint.textContent = t(withoutBackup === 'large' ? 'editor.file.compareLarge' : 'editor.file.compareNoSwap');
        if (backup) hint.textContent = t('editor.file.backupTime', {time: typeof backup.savedAt === 'number' && Number.isFinite(backup.savedAt) && backup.savedAt > 0
            ? new Date(backup.savedAt).toLocaleString() : t('editor.file.backupTimeUnknown')});
        const panes = document.createElement('div'); panes.className = 'mdx-file-compare__panes';
        panes.append(pane(t(backup ? 'editor.file.backup' : 'editor.file.current'), current, start, a.length - tail),
            pane(t(backup ? 'editor.file.current' : 'editor.file.disk'), incoming, start, b.length - tail));
        const keep = document.createElement('button'); keep.type = 'button'; keep.textContent = t('editor.file.keep'); keep.dataset.compareKeep = '';
        const load = document.createElement('button'); load.type = 'button'; load.textContent = t('editor.file.useDisk'); load.dataset.compareLoad = ''; load.hidden = !confirm;
        let done = false;
        const finish = (value: boolean) => {if (done) return; done = true; signal.removeEventListener('abort', abort); dialog.remove(); resolve(value);};
        const abort = () => finish(false); signal.addEventListener('abort', abort, {once: true});
        keep.onclick = () => finish(false); load.onclick = () => finish(true); dialog.oncancel = event => {event.preventDefault(); finish(false);};
        dialog.append(title, hint, panes, keep, load); document.body.append(dialog); dialog.showModal(); keep.focus();
    });
}
