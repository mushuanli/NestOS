import {escapeHTML, t} from '@itookit/common';
import {InputAssetCommand} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';

/** User-initiated previews load verified bytes without enlarging task history. */
export function renderAssetPreviews(value: unknown): string {
    const assets = new Map<string, unknown>();
    const visit = (item: unknown) => {
        if (!item || typeof item !== 'object' || assets.size >= 32) return;
        if (Array.isArray(item)) {item.forEach(visit); return;}
        const record = item as Record<string, unknown>;
        if (typeof record.sha256 === 'string' && typeof record.mimeType === 'string' && /^image\/(png|jpeg|webp)$/.test(record.mimeType)
            && (record.kind === 'input' || typeof record.taskId === 'string')) assets.set(record.sha256, record);
        else Object.values(record).forEach(visit);
    };
    visit(value);
    return [...assets.values()].map(asset => `<span><button type="button" data-asset-preview="${escapeHTML(JSON.stringify(asset))}">${escapeHTML(t('flow.output.previewImage'))}</button></span>`).join('');
}
export function bindAssetPreviews(root: HTMLElement, commands: ICommandBus): void {
    root.querySelectorAll<HTMLButtonElement>('[data-asset-preview]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const url = await commands.execute<string>(InputAssetCommand.Read, {reference: JSON.parse(button.dataset.assetPreview!)});
            if (!button.isConnected) return;
            const image = document.createElement('img'); image.src = url; image.alt = ''; image.style.maxWidth = '100%';
            button.replaceWith(image);
        } catch (error) {if (button.isConnected) {button.disabled = false; button.title = String(error);}}
    }));
}
