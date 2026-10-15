// @file: app-shell/src/ThemeService.ts
// Manages light / dark / system theme preference.
// Persists through the document port; applies data-theme on <html>.

import type { VfsJsonStore } from './persistence/vfs-json-store';

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_CHANGE_EVENT = 'app:theme-change';
/**
 * Mirror of the chosen mode for the next launch's pre-paint script (`index.html`): the shell is
 * painted from `localStorage` before the VFS-backed preference can be read.
 */
const THEME_MIRROR_KEY = 'mindos.theme';

export class ThemeService {
    private mode: ThemeMode = 'system';
    private mq: MediaQueryList;
    private mqListener: () => void;
    private store?: Pick<VfsJsonStore, 'read' | 'write' | 'flush'>;
    private readonly themeChanged = (event: Event) => {
        const mode = (event as CustomEvent<{ mode: ThemeMode }>).detail?.mode;
        if (mode) this.applyMode(mode);
    };

    constructor() {
        this.mq = window.matchMedia('(prefers-color-scheme: dark)');
        this.mqListener = () => {
            if (this.mode === 'system') this.applyTheme();
        };
        this.mq.addEventListener('change', this.mqListener);
    }

    /** Load the persisted preference and apply the theme. */
    async init(store: Pick<VfsJsonStore, 'read' | 'write' | 'flush'>): Promise<void> {
        this.store = store;
        this.mq.removeEventListener('change', this.mqListener);
        this.mq.addEventListener('change', this.mqListener);
        this.mode = await this.loadMode();
        this.applyTheme();

        // Listen for changes dispatched by AppearanceSettingsEditor
        window.addEventListener(THEME_CHANGE_EVENT, this.themeChanged);
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
        if (!this.store) return 'system';
        try {
            const json = await this.store.read('theme') as { mode?: unknown } | undefined;
            const m = json?.mode;
            return m === 'light' || m === 'dark' || m === 'system' ? m : 'system';
        } catch {
            return 'system';
        }
    }

    private async saveMode(mode: ThemeMode): Promise<void> {
        if (!this.store) return;
        this.store.write('theme', { mode }); await this.store.flush();
    }

    destroy(): void {
        this.mq.removeEventListener('change', this.mqListener);
        window.removeEventListener(THEME_CHANGE_EVENT, this.themeChanged);
        this.store = undefined;
    }
}

export const themeService = new ThemeService();
