import {t} from '@itookit/common';
import {resolveResize, type ImageResizePolicy} from '@itookit/image-parser';

export class ImageResizeSettings {
    private readonly select = document.createElement('select');
    private readonly edge = document.createElement('input');
    private readonly hint = document.createElement('p');
    constructor(host: HTMLElement, private readonly get: () => {override?: ImageResizePolicy; agent?: ImageResizePolicy},
        private readonly changed: (resize?: ImageResizePolicy) => void) {
        const section = document.createElement('section'); section.className = 'llm-input__settings-group'; section.dataset.imagePreferences = '';
        const title = document.createElement('h3'); title.textContent = t('image.settings');
        this.select.setAttribute('aria-label', t('image.settings')); this.select.dataset.imageResizeMode = '';
        for (const [value, label] of [['inherit', t('image.follow')], ['original', t('image.original')], ['max-edge', t('image.custom')]]) {
            const option = document.createElement('option'); option.value = value; option.textContent = label; this.select.append(option);
        }
        this.edge.type = 'number'; this.edge.min = '1'; this.edge.max = '32768'; this.edge.step = '1'; this.edge.dataset.imageMaxEdge = '';
        this.edge.setAttribute('aria-label', t('image.maxEdge'));
        this.select.addEventListener('change', () => this.apply()); this.edge.addEventListener('change', () => this.apply());
        section.append(title, this.select, this.edge, this.hint); host.append(section); this.refresh();
    }
    refresh(): void {
        const {override, agent} = this.get(); this.select.value = override?.mode ?? 'inherit';
        this.edge.hidden = override?.mode !== 'max-edge'; this.edge.value = String(override?.mode === 'max-edge' ? override.maxEdge : 1024);
        try {const effective = resolveResize(override, agent); const size = effective.mode === 'original' ? t('image.original') : String(effective.maxEdge);
            this.select.options[0].textContent = t('image.followLabel', {size}); this.hint.textContent = t('image.hint');}
        catch {this.hint.textContent = t('image.invalid');}
    }
    private apply(): void {
        const mode = this.select.value;
        const resize = mode === 'inherit' ? undefined : mode === 'original' ? {mode: 'original' as const}
            : {mode: 'max-edge' as const, maxEdge: Number(this.edge.value)};
        try {resolveResize(resize); this.edge.setCustomValidity(''); this.changed(resize); this.refresh();}
        catch {this.edge.setCustomValidity(t('image.invalid')); this.edge.reportValidity();}
    }
}
