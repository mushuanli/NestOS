import type {KanbanWorkResource} from '../contracts';
import type {KanbanPresentation} from './ports';
import {escapeHTML, escapeAttr} from './html';

export function workResourcesView(ui: KanbanPresentation, resources: KanbanWorkResource[]): string {
    if (!resources.length) return `<p>${escapeHTML(ui.text('none'))}</p>`;
    return resources.map(resource => `<article class="kanban__work-resource" data-work-resource="${escapeAttr(resource.id)}">
        <strong>${escapeHTML(resource.title)}</strong> · ${escapeHTML(ui.text('workResourceState.' + resource.state))}
        <p><code>${escapeHTML(resource.location)}</code></p>
        <dl>${resource.properties.map(row => `<dt>${escapeHTML(row.label)}</dt><dd>${escapeHTML(row.value)}</dd>`).join('')}</dl>
        ${resource.reasons.map(reason => `<p>${escapeHTML(reasonLabel(ui, reason))}</p>`).join('')}
        <button type="button" data-action="cleanup-work-resource" data-resource="${escapeAttr(resource.id)}" data-version="${escapeAttr(resource.version)}" ${resource.canCleanup ? '' : 'disabled'}>${escapeHTML(ui.text('cleanupWorkResource'))}</button>
        </article>`).join('');
}
function reasonLabel(ui: KanbanPresentation, reason: string): string {
    const key = 'workResourceReason.' + reason, label = ui.text(key); return label.includes(key) ? reason : label;
}
