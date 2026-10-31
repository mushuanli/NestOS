import {escapeHTML, t} from '@itookit/common';
import type {ToolPackageGuide, ToolPackageInfo} from '@itookit/app-contracts/services';

/** Package-owned documentation stays visible independently of registration state. */
export function packageGuide(item: ToolPackageInfo): string {
    if (item.guideError) return `<p class="tool-packages-dialog__error">${escapeHTML(t('toolbox.packages.guideUnavailable'))} · ${escapeHTML(item.guideError)}</p>`;
    const guide = item.guide;
    if (!guide) return '';
    return `<details class="tool-packages-dialog__guide" data-package-guide="${escapeHTML(item.id + '@' + item.version)}">
        <summary>${escapeHTML(t('toolbox.packages.guide'))}</summary>${guideContent(guide)}</details>`;
}

export function guideContent(guide: ToolPackageGuide): string {
    return `<div class="tool-packages-dialog__guide"><h4>${escapeHTML(guide.title)}</h4>
        ${guide.description ? `<p>${escapeHTML(guide.description)}</p>` : ''}
        <ol>${guide.steps.map(step => `<li><strong>${escapeHTML(step.title)}</strong><p>${escapeHTML(step.description)}</p>
            ${step.command ? `<pre><code>${escapeHTML(step.command)}</code></pre>` : ''}
            ${step.links?.length ? `<ul>${step.links.filter(link => safeGuideLink(link.url)).map(link => `<li><a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(link.label)}</a></li>`).join('')}</ul>` : ''}</li>`).join('')}</ol></div>`;
}

function safeGuideLink(value: string): boolean {
    try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;}
    catch {return false;}
}
