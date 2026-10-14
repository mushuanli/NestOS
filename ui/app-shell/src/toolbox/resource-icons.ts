import { escapeHTML, TOOLBOX_ICONS, TOOLBOX_PROVIDER_ICONS, t } from '@itookit/common';
import type { ToolboxKind } from './routes';

/** Configured icons are text, never executable markup. */
export function resourceIcon(kind: ToolboxKind, configured?: string, label = t(`toolbox.${kind}`), fallback = TOOLBOX_ICONS[kind]): string {
    const text = configured?.trim();
    const icon = text && text.length <= 16 && !/[<>]/.test(text) ? escapeHTML(text) : fallback;
    return `<span role="img" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}">${icon}</span>`;
}

export function providerIcon(id: string, customIcon?: string): string {
    return resourceIcon('providers', customIcon, t('toolbox.providers'), TOOLBOX_PROVIDER_ICONS[id] ?? TOOLBOX_ICONS.providers);
}
