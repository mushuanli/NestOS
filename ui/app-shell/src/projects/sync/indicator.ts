import { ENTITY_ICONS, FEEDBACK_ICONS, escapeAttr, t, randomUUID } from '@itookit/common';
import { syncIndicatorDescription, type ProjectSyncIndicator } from './presentation';

/** Icon markup uses only shared icons; names and issues are escaped as attribute text. */
export function projectSyncIcon(remote: boolean, value: ProjectSyncIndicator): string {
    const icon = remote ? ENTITY_ICONS.remoteProject : ENTITY_ICONS.project;
    const warning = value.state === 'configured' ? '' : `<span class="project-sync-icon__warning">${FEEDBACK_ICONS.warning}</span>`;
    return `<span class="project-sync-icon" title="${escapeAttr(syncIndicatorDescription(value))}">${icon}<span class="project-sync-icon__badge">${ENTITY_ICONS.sync}</span>${warning}</span>`;
}

/** The current project's indicator opens status and exposes a tooltip on hover or focus. */
export class ProjectSyncStatusIndicator {
    readonly element = document.createElement('span');
    private readonly button = document.createElement('button');
    private readonly tooltip = document.createElement('span');
    constructor(open: () => void) {
        this.element.className = 'project-sync-status'; this.element.hidden = true;
        this.button.type = 'button'; this.button.onclick = open;
        this.tooltip.id = 'project-sync-status-' + randomUUID(); this.tooltip.className = 'project-sync-status__tooltip';
        this.tooltip.setAttribute('role', 'tooltip'); this.tooltip.hidden = true;
        this.button.setAttribute('aria-describedby', this.tooltip.id);
        this.element.onmouseenter = this.button.onfocus = () => { this.tooltip.hidden = false; };
        this.element.onmouseleave = this.button.onblur = () => { this.tooltip.hidden = true; };
        this.element.append(this.button, this.tooltip);
    }
    update(value?: ProjectSyncIndicator): void {
        this.element.hidden = !value; this.tooltip.hidden = true;
        if (!value) return;
        this.button.className = `project-sync-status__button project-sync-status__button--${value.state}`;
        this.button.textContent = value.state === 'configured' ? ENTITY_ICONS.sync : FEEDBACK_ICONS.warning;
        this.button.setAttribute('aria-label', syncIndicatorDescription(value));
        this.tooltip.replaceChildren();
        const heading = document.createElement('strong'); heading.textContent = value.label; this.tooltip.append(heading);
        if (value.target) this.line(t('project.sync.indicator.target', {name: value.target}));
        if (value.direction) this.line(value.direction);
        if (value.issues.length) {
            this.line(t('project.sync.indicator.issues'));
            const list = document.createElement('ul');
            for (const issue of value.issues) { const item = document.createElement('li'); item.textContent = issue; list.append(item); }
            this.tooltip.append(list);
        }
    }
    private line(text: string): void {
        const line = document.createElement('span'); line.textContent = text; this.tooltip.append(line);
    }
}
