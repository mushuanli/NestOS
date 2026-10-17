import { t } from '@itookit/common';
import { resolveBrowserTarget } from '@itookit/app-contracts';
import type { ApplicationBackend, SessionTaskPage, TaskDetail, TaskEventView } from '@itookit/app-contracts/services';

type TaskBackend = Pick<ApplicationBackend, 'sessionTasks' | 'taskDetails' | 'taskEvents'>;
interface TaskViewHost {
    begin(): () => boolean;
    mount(panel: HTMLElement): void;
    open(path: string): Promise<void>;
    report(error: unknown): void;
}

/** Task reads and pagination have their own presentation lifecycle. */
export class SessionTaskView {
    constructor(private readonly backend: TaskBackend, private readonly host: TaskViewHost) {}
    async list(sessionId: string): Promise<void> {
        const current = this.host.begin();
        let page = await this.backend.sessionTasks(sessionId);
        if (!current()) return;
        const panel = detailPanel('Tasks'), entries = document.createElement('div');
        const more = button('加载更多任务'); panel.append(entries, more);
        const append = () => {
            appendTasks(entries, page, path => { void this.host.open(path).catch(error => this.host.report(error)); }, sessionId);
            more.hidden = page.nextAfterIndex === undefined;
        };
        append();
        if (!page.items.length) { const empty = document.createElement('p'); empty.textContent = '暂无内容'; entries.append(empty); }
        more.onclick = () => {
            if (more.disabled || page.nextAfterIndex === undefined) return;
            more.disabled = true;
            void this.backend.sessionTasks(sessionId, { afterIndex: page.nextAfterIndex, throughIndex: page.throughIndex }).then(next => {
                if (current()) { page = next; append(); }
            }).catch(error => { if (current()) this.host.report(error); }).finally(() => { more.disabled = false; });
        };
        this.host.mount(panel);
    }
    async detail(path: string): Promise<void> {
        const target = resolveBrowserTarget(path); if (target.kind !== 'task') return;
        const current = this.host.begin(), detail = await this.backend.taskDetails(target.sessionId, target.taskId);
        if (!current()) return;
        const panel = detailPanel(`${detail.task.program.kind} · ${detail.task.status}`);
        const description = document.createElement('p'); description.textContent = detail.task.id;
        const result = document.createElement('pre'); result.textContent = JSON.stringify(detail.summary, null, 2);
        panel.append(controlState(detail.stat), description, result);
        new TaskTimeline(panel, detail.events, async options => this.backend.taskEvents(target.sessionId, target.taskId, options),
            current, error => this.host.report(error));
        this.host.mount(panel);
    }
}

function detailPanel(title: string): HTMLElement {
    const panel = document.createElement('div'); panel.className = 'session-detail';
    const heading = document.createElement('h2'); heading.textContent = title; panel.append(heading); return panel;
}
function button(label: string): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label; return node;
}
function appendTasks(entries: HTMLElement, page: SessionTaskPage, open: (path: string) => void, sessionId: string): void {
    for (const task of page.items) {
        const entry = button(`${task.program.kind} · ${task.status} · ${task.id}`); entry.className = 'session-detail__entry';
        entry.onclick = () => open(`/${sessionId}/tasks/${task.id}`); entries.append(entry);
    }
}
function controlState(stat: TaskDetail['stat']): HTMLElement {
    const node = document.createElement('p'), control = stat.control;
    const kind = control.requested === 'cancel' ? 'cancel' : control.requested === 'pause' ? 'pause' : undefined;
    node.dataset.stopState = !kind ? 'none' : kind === 'cancel' ? (control.acknowledged ? 'stopped' : 'pending')
        : (control.acknowledged ? 'paused' : 'pause-pending');
    node.textContent = !kind ? '' : kind === 'cancel' ? (control.acknowledged ? t('session.tasks.stopStopped')
        : t('session.tasks.stopPending', { count: stat.activeOperations })) : (control.acknowledged ? t('session.tasks.pauseStopped')
        : t('session.tasks.pausePending', { count: stat.activeOperations }));
    node.hidden = !kind; return node;
}

class TaskTimeline {
    private readonly entries = document.createElement('div');
    private readonly trimmed = document.createElement('p');
    private readonly more = button('继续查找关键事件');
    private readonly events: TaskEventView['items'];
    private watermark: number;
    constructor(panel: HTMLElement, private page: TaskEventView,
        private readonly read: (options: { afterIndex?: number; throughIndex?: number }) => Promise<TaskEventView>,
        private readonly current: () => boolean, private readonly report: (error: unknown) => void) {
        this.events = [...page.items]; this.watermark = page.firstAvailableIndex ?? 1;
        this.trimmed.dataset.eventsTrimmed = 'true'; this.trimmed.textContent = t('session.tasks.eventsTrimmed');
        panel.append(this.entries, this.trimmed, this.more);
        this.more.onclick = () => { void this.loadMore(); }; this.render();
    }
    private async loadMore(): Promise<void> {
        if (this.more.disabled || this.page.nextAfterIndex === undefined) return;
        this.more.disabled = true;
        try {
            const page = await this.read({ afterIndex: this.page.nextAfterIndex, throughIndex: this.page.throughIndex });
            if (!this.current()) return;
            this.page = page; this.watermark = Math.max(this.watermark, page.firstAvailableIndex ?? 1);
            this.events.push(...page.items); this.render();
        } catch (error) { if (this.current()) this.report(error); }
        finally { this.more.disabled = false; }
    }
    private render(): void {
        this.trimmed.hidden = this.watermark <= 1; this.trimmed.dataset.eventsTrimmedFrom = String(this.watermark);
        this.entries.replaceChildren(); this.more.hidden = this.page.nextAfterIndex === undefined;
        if (!this.events.length) { const empty = document.createElement('p'); empty.textContent = '已读取范围内无关键事件'; this.entries.append(empty); }
        for (const event of [...this.events].sort((a, b) => a.occurredAt - b.occurredAt)) {
            const detail = document.createElement('details'), summary = document.createElement('summary');
            summary.textContent = `${new Date(event.occurredAt).toLocaleString()} · ${event.type}`;
            const body = document.createElement('pre'); body.textContent = JSON.stringify(event, null, 2);
            detail.append(summary, body); this.entries.append(detail);
        }
    }
}
