import { t } from '@itookit/common';
import type { FileSystemContextOwner } from '@itookit/vfs-core';
import type { ViewLoad } from '../lifecycle/view-load';

export const PROJECT_EDITOR_MAX_BYTES = 32 * 1024 * 1024;
const PREVIEW_BYTES = 256 * 1024;
const BINARY_EXTENSION = /\.(pdf|zip|gz|tar|7z|rar|png|jpe?g|gif|webp|avif|ico|bmp|heic|mp[34]|wav|ogg|webm|mov|mkv|flac|woff2?|ttf|bin|sqlite3?|db|docx?|xlsx?|pptx?)$/i;

/** A plain read-only fragment never enters an editor or acquires a save command. */
export async function showLargeFilePreview(owner: FileSystemContextOwner, path: string,
    size: number | undefined, mount: HTMLElement, load: ViewLoad): Promise<() => void> {
    const panel = document.createElement('section'); panel.className = 'project-file-preview';
    const heading = document.createElement('h2'); heading.textContent = path.split('/').pop() ?? path;
    const notice = document.createElement('p'); notice.setAttribute('role', 'status');
    notice.textContent = t('project.largeFile', { size: size === undefined ? t('project.unknownSize') : `${(size / 1024 / 1024).toFixed(1)} MiB` });
    panel.append(heading, notice);
    if (!BINARY_EXTENSION.test(path)) {
        const bytes = await load.read(() => owner.context.fs.driver.readContent(path, { encoding: 'binary',
            offset: 0, length: PREVIEW_BYTES, signal: load.signal }));
        load.check();
        const content = previewText(bytes);
        if (content !== undefined) {
            notice.textContent += ' ' + t('project.largeTextPreview');
            const pre = document.createElement('pre'); pre.tabIndex = 0; pre.textContent = content; panel.append(pre);
        } else notice.textContent += ' ' + t('project.largeBinaryPreview');
    } else notice.textContent += ' ' + t('project.largeBinaryPreview');
    load.check(); mount.replaceChildren(panel);
    return () => panel.remove();
}
function previewText(bytes: ArrayBuffer): string | undefined {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
        if (!text.includes('\0')) return text;
    } catch { /* Non-text content is never rendered as editable text. */ }
}
