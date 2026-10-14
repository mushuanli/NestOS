// @file: app-shell/src/ThemeService.ts
// Manages light / dark / system theme preference.
// Persists to etc:/ui/theme.json via VFS; applies data-theme on <html>.

import type { IFileSystem } from '@itookit/vfs-core';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_CHANGE_EVENT = 'app:theme-change';
const THEME_PATH = '/ui/theme.json';
/**
 * Mirror of the chosen mode for the next launch's pre-paint script (`index.html`): the shell is
 * painted from `localStorage` before the VFS-backed preference can be read.
 */
const THEME_MIRROR_KEY = 'mindos.theme';

export class ThemeService {
    private mode: ThemeMode = 'system';
    private mq: MediaQueryList;
    private mqListener: () => void;
    private vfs: IFileSystem | null = null;

    constructor() {
        this.mq = window.matchMedia('(prefers-color-scheme: dark)');
        this.mqListener = () => {
            if (this.mode === 'system') this.applyTheme();
        };
        this.mq.addEventListener('change', this.mqListener);
    }

    /** Call after VFS is ready. Loads persisted preference and applies theme. */
    async init(vfs: IFileSystem): Promise<void> {
        this.vfs = vfs;
        this.mode = await this.loadMode();
        this.applyTheme();

        // Listen for changes dispatched by AppearanceSettingsEditor
        window.addEventListener(THEME_CHANGE_EVENT, (e) => {
            const mode = (e as CustomEvent<{ mode: ThemeMode }>).detail?.mode;
            if (mode) this.applyMode(mode);
        });
    }

    getMode(): ThemeMode {
        return this.mode;
    }

    getEffective(): 'light' | 'dark' {
        return this.mode === 'system'
            ? (this.mq.matches ? 'dark' : 'light')
            : this.mode;
    }

    async setMode(mode: ThemeMode): Promise<void> {
        this.mode = mode;
        this.applyTheme();
        await this.saveMode(mode);
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, {
            detail: { mode, effective: this.getEffective() },
        }));
    }

    /** Apply without persisting — used internally when reacting to events */
    private applyMode(mode: ThemeMode): void {
        this.mode = mode;
        this.applyTheme();
    }

    private applyTheme(): void {
        document.documentElement.setAttribute('data-theme', this.getEffective());
        // Remember the mode (not the resolved colour) so a 'system' choice stays live on the next
        // launch; failures (private mode, storage disabled) only cost the pre-paint colour.
        try { window.localStorage.setItem(THEME_MIRROR_KEY, this.mode); } catch { /* keep going */ }
    }

    private async loadMode(): Promise<ThemeMode> {
        if (!this.vfs) return 'system';
        try {
            const raw = await this.vfs.driver.readContent(THEME_PATH);
            const json = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer));
            const m = json?.mode;
            return m === 'light' || m === 'dark' || m === 'system' ? m : 'system';
        } catch {
            return 'system';
        }
    }

    private async saveMode(mode: ThemeMode): Promise<void> {
        if (!this.vfs) return;
        const content = JSON.stringify({ mode }, null, 2);
        if (await this.vfs.driver.exists(THEME_PATH)) await this.vfs.driver.writeContent(THEME_PATH, content);
        else await this.vfs.driver.createFile({ name: 'theme.json', parentPath: '/ui', content, recursive: true });
    }

    destroy(): void {
        this.mq.removeEventListener('change', this.mqListener);
    }
}

export const themeService = new ThemeService();
