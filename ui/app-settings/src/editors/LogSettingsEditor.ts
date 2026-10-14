/**
 * @file app-settings/editors/LogSettingsEditor.ts
 * @description 日志管理设置页面
 */

import { BaseSettingsEditor } from '@itookit/ui-common';
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';
import { LogOverviewSection } from './log/LogOverviewSection';
import { LogLevelConfigSection } from './log/LogLevelConfigSection';
import { LogViewerSection } from './log/LogViewerSection';

export class LogSettingsEditor extends BaseSettingsEditor<SettingsService> {
    private sections: Array<{ destroy?: () => void }> = [];
    private isStructureInitialized = false;

    async init(container: HTMLElement): Promise<void> {
        await super.init(container);
    }

    async render(): Promise<void> {
        if (this.isStructureInitialized) {
            // 通知子组件刷新
            this.sections.forEach((s: any) => s.refresh?.());
            return;
        }

        this.container.innerHTML = `
            <div class="settings-page">
                <div class="settings-page__header">
                    <div>
                        <h2 class="settings-page__title">日志管理</h2>
                        <p class="settings-page__description">查看系统日志、配置日志级别</p>
                    </div>
                </div>

                <div id="section-log-overview"></div>
                <div id="section-log-level"></div>
                <div id="section-log-viewer"></div>
            </div>
        `;

        const overviewEl = this.container.querySelector('#section-log-overview') as HTMLElement;
        const levelEl = this.container.querySelector('#section-log-level') as HTMLElement;
        const viewerEl = this.container.querySelector('#section-log-viewer') as HTMLElement;

        const overviewSection = new LogOverviewSection(overviewEl);
        const levelSection = new LogLevelConfigSection(levelEl, this.service);
        const viewerSection = new LogViewerSection(viewerEl);

        this.sections = [overviewSection, levelSection, viewerSection];

        await Promise.all(this.sections.map((s: any) => s.init?.()));

        this.isStructureInitialized = true;
    }

    async destroy(): Promise<void> {
        this.sections.forEach(s => s.destroy?.());
        this.sections = [];
        this.isStructureInitialized = false;
        await super.destroy();
    }
}

export default LogSettingsEditor;
