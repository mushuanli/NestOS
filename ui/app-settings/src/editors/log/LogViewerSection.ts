/**
 * @file app-settings/editors/log/LogViewerSection.ts
 * @description 日志查看器 - 支持过滤、搜索、实时刷新
 */

import {
    getLogger,
    LogLevel,
    LogLevelNames,
    LogEntry,
    LogFilter,
    escapeHTML
} from '@itookit/common';
import { Toast, Modal } from '@itookit/ui-common';

export class LogViewerSection {
    private container: HTMLElement;
    private autoRefresh = false;
    private refreshTimer: number | null = null;

    // 过滤状态
    private filterModule: string = '';
    private filterLevel: LogLevel | null = null;
    private filterStartTime: number | null = null;
    private filterEndTime: number | null = null;
    private searchText: string = '';
    private displayLimit: number = 100;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    async init(): Promise<void> {
        this.render();
    }

    render(): void {
        const logs = this.queryLogs();
        const logger = getLogger();
        const stats = logger.getStats();

        this.container.innerHTML = `
            <div class="settings-section">
                <div class="settings-section__header">
                    <h3 class="settings-section__title">
                        <span class="settings-section__icon">📜</span>
                        日志查看器
                    </h3>
                    <div class="settings-section__actions">
                        <button class="settings-btn settings-btn--icon ${this.autoRefresh ? 'settings-btn--active' : ''}" 
                                id="auto-refresh-btn" title="自动刷新">
                            <i class="fas fa-sync-alt ${this.autoRefresh ? 'fa-spin' : ''}"></i>
                        </button>
                        <button class="settings-btn settings-btn--icon" id="refresh-btn" title="刷新">
                            <i class="fas fa-redo"></i>
                        </button>
                        <button class="settings-btn settings-btn--icon settings-btn--danger" id="clear-btn" title="清空日志">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="settings-section__content">
                    <!-- 过滤器 -->
                    <div class="log-viewer__filters">
                        <div class="log-viewer__filter-group">
                            <label>模块</label>
                            <input type="text" class="settings-input settings-input--sm" 
                                   id="filter-module" placeholder="输入模块名..." 
                                   value="${escapeHTML(this.filterModule)}">
                        </div>
                        <div class="log-viewer__filter-group">
                            <label>最低级别</label>
                            <select class="settings-select settings-select--sm" id="filter-level">
                                <option value="">全部</option>
                                ${this.renderLevelFilterOptions()}
                            </select>
                        </div>
                        <div class="log-viewer__filter-group">
                            <label>时间范围</label>
                            <select class="settings-select settings-select--sm" id="filter-time">
                                <option value="">全部</option>
                                <option value="1">最近 1 分钟</option>
                                <option value="5">最近 5 分钟</option>
                                <option value="15">最近 15 分钟</option>
                                <option value="60">最近 1 小时</option>
                            </select>
                        </div>
                        <div class="log-viewer__filter-group log-viewer__filter-group--search">
                            <label>搜索</label>
                            <input type="text" class="settings-input settings-input--sm" 
                                   id="filter-search" placeholder="搜索内容..." 
                                   value="${escapeHTML(this.searchText)}">
                        </div>
                        <button class="settings-btn settings-btn--secondary settings-btn--sm" id="apply-filter-btn">
                            <i class="fas fa-filter"></i> 应用
                        </button>
                        <button class="settings-btn settings-btn--ghost settings-btn--sm" id="reset-filter-btn">
                            重置
                        </button>
                    </div>

                    <!-- 日志列表 -->
                    <div class="log-viewer__list" id="log-list">
                        ${this.renderLogList(logs)}
                    </div>

                    <!-- 状态栏 -->
                    <div class="log-viewer__status">
                        <span>显示 ${logs.length} / ${stats.totalEntries} 条</span>
                        <div class="log-viewer__limit">
                            <label>显示条数:</label>
                            <select class="settings-select settings-select--xs" id="display-limit">
                                <option value="50" ${this.displayLimit === 50 ? 'selected' : ''}>50</option>
                                <option value="100" ${this.displayLimit === 100 ? 'selected' : ''}>100</option>
                                <option value="200" ${this.displayLimit === 200 ? 'selected' : ''}>200</option>
                                <option value="500" ${this.displayLimit === 500 ? 'selected' : ''}>500</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.bindEvents();
    }

    private renderLevelFilterOptions(): string {
        return Object.entries(LogLevelNames)
            .filter(([key]) => parseInt(key) !== LogLevel.SILENT)
            .map(([key, name]) => {
                const level = parseInt(key);
                const selected = this.filterLevel === level ? 'selected' : '';
                return `<option value="${level}" ${selected}>${name}+</option>`;
            })
            .join('');
    }

    private renderLogList(logs: LogEntry[]): string {
        if (logs.length === 0) {
            return `
                <div class="log-viewer__empty">
                    <i class="fas fa-inbox"></i>
                    <p>暂无日志记录</p>
                </div>
            `;
        }

        // 按时间倒序显示（最新在前）
        const sortedLogs = [...logs].reverse();

        return sortedLogs.map(log => {
            const levelClass = this.getLevelClass(log.level);
            const levelName = LogLevelNames[log.level] || 'UNKNOWN';
            const time = new Date(log.timestamp).toLocaleTimeString();
            const dataStr = log.data ? ` | ${JSON.stringify(log.data)}` : '';

            return `
                <div class="log-viewer__entry log-viewer__entry--${levelClass}">
                    <span class="log-viewer__entry-time">${time}</span>
                    <span class="log-viewer__entry-level log-viewer__entry-level--${levelClass}">${levelName}</span>
                    <span class="log-viewer__entry-module">${escapeHTML(log.module)}</span>
                    <span class="log-viewer__entry-message">${escapeHTML(log.message)}${escapeHTML(dataStr)}</span>
                </div>
            `;
        }).join('');
    }

    private getLevelClass(level: LogLevel): string {
        switch (level) {
            case LogLevel.DEBUG: return 'debug';
            case LogLevel.INFO: return 'info';
            case LogLevel.WARN: return 'warn';
            case LogLevel.ERROR: return 'error';
            default: return 'info';
        }
    }

    private queryLogs(): LogEntry[] {
        const logger = getLogger();
        const filter: LogFilter = {
            limit: this.displayLimit
        };

        if (this.filterModule) {
            filter.modules = [this.filterModule];
        }

        if (this.filterLevel !== null) {
            filter.minLevel = this.filterLevel;
        }

        if (this.filterStartTime) {
            filter.startTime = this.filterStartTime;
        }

        if (this.filterEndTime) {
            filter.endTime = this.filterEndTime;
        }

        let logs = logger.query(filter);

        // 客户端文本搜索
        if (this.searchText) {
            const searchLower = this.searchText.toLowerCase();
            logs = logs.filter(log =>
                log.message.toLowerCase().includes(searchLower) ||
                log.module.toLowerCase().includes(searchLower)
            );
        }

        return logs;
    }

    private bindEvents(): void {
        // 自动刷新
        const autoRefreshBtn = this.container.querySelector('#auto-refresh-btn');
        autoRefreshBtn?.addEventListener('click', () => {
            this.autoRefresh = !this.autoRefresh;
            if (this.autoRefresh) {
                this.refreshTimer = window.setInterval(() => this.updateLogList(), 2000);
                Toast.info('已开启自动刷新');
            } else {
                if (this.refreshTimer) {
                    clearInterval(this.refreshTimer);
                    this.refreshTimer = null;
                }
                Toast.info('已关闭自动刷新');
            }
            this.render();
        });

        // 手动刷新
        const refreshBtn = this.container.querySelector('#refresh-btn');
        refreshBtn?.addEventListener('click', () => {
            this.updateLogList();
            Toast.success('日志已刷新');
        });

        // 清空日志
        const clearBtn = this.container.querySelector('#clear-btn');
        clearBtn?.addEventListener('click', () => {
            Modal.confirm('确认清空', '确定要清空所有日志吗？此操作不可恢复。', () => {
                getLogger().clear();
                this.updateLogList();
                Toast.success('日志已清空');
            });
        });

        // 应用过滤
        const applyBtn = this.container.querySelector('#apply-filter-btn');
        applyBtn?.addEventListener('click', () => this.applyFilters());

        // 重置过滤
        const resetBtn = this.container.querySelector('#reset-filter-btn');
        resetBtn?.addEventListener('click', () => {
            this.filterModule = '';
            this.filterLevel = null;
            this.filterStartTime = null;
            this.filterEndTime = null;
            this.searchText = '';
            this.render();
        });

        // 显示条数
        const limitSelect = this.container.querySelector('#display-limit') as HTMLSelectElement;
        limitSelect?.addEventListener('change', () => {
            this.displayLimit = parseInt(limitSelect.value);
            this.updateLogList();
        });

        // 回车应用过滤
        const searchInput = this.container.querySelector('#filter-search');
        searchInput?.addEventListener('keypress', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') {
                this.applyFilters();
            }
        });
    }

    private applyFilters(): void {
        const moduleInput = this.container.querySelector('#filter-module') as HTMLInputElement;
        const levelSelect = this.container.querySelector('#filter-level') as HTMLSelectElement;
        const timeSelect = this.container.querySelector('#filter-time') as HTMLSelectElement;
        const searchInput = this.container.querySelector('#filter-search') as HTMLInputElement;

        this.filterModule = moduleInput?.value.trim() || '';
        this.filterLevel = levelSelect?.value ? parseInt(levelSelect.value) as LogLevel : null;
        this.searchText = searchInput?.value.trim() || '';

        // 时间范围
        const timeMinutes = timeSelect?.value ? parseInt(timeSelect.value) : 0;
        if (timeMinutes > 0) {
            this.filterStartTime = Date.now() - timeMinutes * 60 * 1000;
            this.filterEndTime = null;
        } else {
            this.filterStartTime = null;
            this.filterEndTime = null;
        }

        this.updateLogList();
    }

    private updateLogList(): void {
        const logList = this.container.querySelector('#log-list');
        const statusSpan = this.container.querySelector('.log-viewer__status span');

        if (logList) {
            const logs = this.queryLogs();
            logList.innerHTML = this.renderLogList(logs);

            if (statusSpan) {
                const stats = getLogger().getStats();
                statusSpan.textContent = `显示 ${logs.length} / ${stats.totalEntries} 条`;
            }
        }
    }

    refresh(): void {
        this.updateLogList();
    }

    destroy(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}
