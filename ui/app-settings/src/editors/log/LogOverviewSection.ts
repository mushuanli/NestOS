/**
 * @file app-settings/editors/log/LogOverviewSection.ts
 * @description 日志缓冲区概览统计
 */

import { getLogger } from '@itookit/common';

export class LogOverviewSection {
    private container: HTMLElement;
    private refreshTimer: number | null = null;

    constructor(container: HTMLElement) {
        this.container = container;
    }

    async init(): Promise<void> {
        this.render();
        // 每 5 秒自动刷新统计
        this.refreshTimer = window.setInterval(() => this.render(), 5000);
    }

    render(): void {
        const logger = getLogger();
        const stats = logger.getStats();

        const usagePercent = stats.maxSize > 0
            ? Math.round((stats.bufferSize / stats.maxSize) * 100)
            : 0;

        const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            return `${(bytes / 1024).toFixed(1)} KB`;
        };

        const formatTime = (ts: number | null) => {
            if (!ts) return '-';
            return new Date(ts).toLocaleTimeString();
        };

        this.container.innerHTML = `
            <div class="settings-section">
                <div class="settings-section__header">
                    <h3 class="settings-section__title">
                        <span class="settings-section__icon">📊</span>
                        缓冲区概览
                    </h3>
                </div>
                <div class="settings-section__content">
                    <div class="log-overview">
                        <div class="log-overview__progress">
                            <div class="log-overview__progress-bar">
                                <div class="log-overview__progress-fill" style="width: ${usagePercent}%"></div>
                            </div>
                            <div class="log-overview__progress-text">
                                <span>${formatSize(stats.bufferSize)} / ${formatSize(stats.maxSize)}</span>
                                <span>${usagePercent}%</span>
                            </div>
                        </div>
                        <div class="log-overview__stats">
                            <div class="log-overview__stat">
                                <span class="log-overview__stat-label">日志条数</span>
                                <span class="log-overview__stat-value">${stats.totalEntries}</span>
                            </div>
                            <div class="log-overview__stat">
                                <span class="log-overview__stat-label">最早记录</span>
                                <span class="log-overview__stat-value">${formatTime(stats.oldestTimestamp)}</span>
                            </div>
                            <div class="log-overview__stat">
                                <span class="log-overview__stat-label">最新记录</span>
                                <span class="log-overview__stat-value">${formatTime(stats.newestTimestamp)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    refresh(): void {
        this.render();
    }

    destroy(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}
