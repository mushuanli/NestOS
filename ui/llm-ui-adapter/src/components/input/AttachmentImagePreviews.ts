import {t} from '@itookit/common';
import {knownImageFileState} from './image-file-state';

/** Preview URLs follow immutable attachment versions and are never persisted. */
export class AttachmentImagePreviews {
    private readonly urls = new Map<File, string>();
    render(files: File[], container: HTMLElement, edit: (file: File) => void): void {
        for (const [file, url] of this.urls) if (!files.includes(file)) {URL.revokeObjectURL(url); this.urls.delete(file);}
        const tags = container.querySelectorAll<HTMLElement>('.llm-input__attachment-tag');
        files.forEach((file, index) => {
            if (!file.type.startsWith('image/')) return;
            const tag = tags[index]; if (!tag) return;
            const control = document.createElement('button'); control.type = 'button'; control.className = 'llm-input__image-edit';
            control.title = t('image.edit'); control.setAttribute('aria-label', `${t('image.edit')} ${file.name}`);
            control.addEventListener('click', () => edit(file));
            const state = knownImageFileState(file), url = state?.resizeKey ? this.url(file) : undefined;
            if (url) {const image = document.createElement('img'); image.src = url; image.alt = ''; control.append(image);}
            else control.textContent = t('image.edit');
            tag.querySelector('.llm-input__file-icon')?.replaceWith(control);
            if (state && (state.spec.selection.kind !== 'none' || (state.spec.version === 2 && state.spec.steps.some(step => step.kind !== 'none')))) {
                const badge = document.createElement('span'); badge.className = 'llm-input__image-edited'; badge.textContent = t('image.edited'); tag.append(badge);
            }
        });
    }
    private url(file: File): string | undefined {
        if (this.urls.has(file)) return this.urls.get(file);
        if (typeof URL.createObjectURL !== 'function') return;
        try {const url = URL.createObjectURL(file); this.urls.set(file, url); return url;} catch {return;}
    }
    destroy(): void {for (const url of this.urls.values()) URL.revokeObjectURL(url); this.urls.clear();}
}
