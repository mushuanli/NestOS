// @file: app-settings/editors/AppearanceSettingsEditor.ts
import { BaseSettingsEditor } from '@itookit/ui-common';
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';

type ThemeMode = 'light' | 'dark' | 'system';

const THEME_PATH = '/ui/theme.json';
const THEME_CHANGE_EVENT = 'app:theme-change';

export class AppearanceSettingsEditor extends BaseSettingsEditor<SettingsService> {
    async render() {
        const current = await this.loadMode();

        this.container.innerHTML = `
            <div class="settings-page">
                <h2 class="settings-page__title">外观</h2>
                <p class="settings-page__description">选择界面主题，或跟随系统设置自动切换。</p>

                <div class="st-appearance__grid">
                    ${this.renderOption('light',  '浅色',     current)}
                    ${this.renderOption('system', '跟随系统', current)}
                    ${this.renderOption('dark',   '深色',     current)}
                </div>
            </div>
        `;

        this.container.querySelectorAll<HTMLButtonElement>('.st-appearance__option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.mode as ThemeMode;
                await this.saveMode(mode);
                window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { mode } }));

                this.container.querySelectorAll('.st-appearance__option').forEach(b =>
                    b.classList.toggle('st-appearance__option--active', b === btn)
                );
            });
        });
    }

    private renderOption(mode: ThemeMode, label: string, current: ThemeMode): string {
        const active = mode === current ? ' st-appearance__option--active' : '';
        return `
            <button class="st-appearance__option${active}" data-mode="${mode}" type="button">
                <div class="st-appearance__preview">${this.renderPreview(mode)}</div>
                <span class="st-appearance__label">${label}</span>
            </button>
        `;
    }

    private renderPreview(mode: ThemeMode): string {
        const mock = (cls: string) => `
            <div class="st-appearance__mock st-appearance__mock--${cls}">
                <div class="st-appearance__mock-bar"></div>
                <div class="st-appearance__mock-content">
                    <div class="st-appearance__mock-line"></div>
                    <div class="st-appearance__mock-line st-appearance__mock-line--short"></div>
                </div>
            </div>`;
        if (mode !== 'system') return mock(mode);
        return `<div class="st-appearance__mock st-appearance__mock--system">
            <div class="st-appearance__mock-half st-appearance__mock-half--light">
                <div class="st-appearance__mock-bar"></div>
            </div>
            <div class="st-appearance__mock-half st-appearance__mock-half--dark">
                <div class="st-appearance__mock-bar"></div>
            </div>
        </div>`;
    }

    private async loadMode(): Promise<ThemeMode> {
        try {
            const raw = await this.service.readPreference(THEME_PATH);
            const json = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer));
            const m = json?.mode;
            return m === 'light' || m === 'dark' || m === 'system' ? m : 'system';
        } catch {
            return 'system';
        }
    }

    private async saveMode(mode: ThemeMode): Promise<void> {
        await this.service.writePreference(THEME_PATH, JSON.stringify({ mode }, null, 2));
    }
}
