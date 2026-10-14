import { SettingsAutoSave, type SettingsSave } from './SettingsAutoSave';
import { editorFilePath } from '../interfaces/IEditor';
// @file ui-common/components/BaseSettingsEditor.ts
/// <reference lib="dom" />

import { IEditor, CollapseExpandResult, EditorOptions, UnifiedSearchResult, Heading, EditorEvent, EditorEventCallback } from '../interfaces/IEditor';
import { t, escapeAttr } from '@itookit/common';

/**
 * 定义宿主能力接口 (与 MemoryManager 的 EditorHostContext 保持结构兼容)
 */
export interface IEditorHostContext {
    toggleSidebar: (collapsed?: boolean) => void;
    saveContent: (nodeId: string, content: string) => Promise<void>;
}

interface ChangeObservable {
    onChange(callback: () => void): () => void;
}

function isChangeObservable(service: unknown): service is ChangeObservable {
    if (typeof service !== 'object' || service === null || !('onChange' in service)) {
        return false;
    }
    return typeof service.onChange === 'function';
}

/** System emoji icons shown in the entity header icon picker. */
const SYSTEM_ICONS = [
    '📝', '📄', '📋', '✅', '❌', '⚡', '🔥', '⭐', '💡', '🔧',
    '⚙️', '🔌', '🌐', '🖥️', '📱', '🤖', '🎯', '🚀', '💎', '🔑',
    '🏷️', '📌', '📊', '📈', '🛠️', '🧩', '🔍', '🎨', '🧪', '🔬',
    '⚗️', '📡', '🗂️', '🔔', '🎵', '🏗️', '📦', '🧲', '🎪', '🧠',
    '💬', '📢', '🔗', '🛡️', '🎮', '📐', '🧮', '🔋', '💊', '🐍',
];

/**
 * 设置类编辑器的基类
 * @template TService 服务层的类型
 */
export abstract class BaseSettingsEditor<TService> implements IEditor {
    protected listeners: Array<{ target: EventTarget, type: string, handler: EventListener }> = [];
    protected container!: HTMLElement;
    private readonly autoSaves = new Set<SettingsAutoSave>();

    // [新增] 宿主能力引用
    protected hostContext?: IEditorHostContext;

    constructor(
        container: HTMLElement,
        protected service: TService,
        protected options: EditorOptions
    ) {
        this.container = container;
    }

    async init(container: HTMLElement, _initialContent?: string) {
        this.container = container;
        this.container.classList.add('settings-root');

        // [新增] 消费宿主能力
        // 策略层(Strategy)会将 hostContext 注入到 options 中
        if (this.options.hostContext) {
            this.hostContext = this.options.hostContext as IEditorHostContext;
        }

        // Service 变更订阅
        if (isChangeObservable(this.service)) {
            const unsubscribe = this.service.onChange(() => {
                if (![...this.autoSaves].some(save => save.protectsInput)) void this.render();
            });

            // Hook destroy
            const originalDestroy = this.destroy;
            this.destroy = async () => {
                await originalDestroy.call(this);
                unsubscribe();
            };
        }

        await this.render();
    }

    // [新增] 辅助方法：切换侧边栏
    protected toggleSidebar() {
        this.hostContext?.toggleSidebar();
    }

    /**
     * Sync node metadata (icon, description, etc.) to the engine so vfs-ui
     * refreshes its list display. Safe to call without engine — no-ops silently.
     */
    protected async syncMetadata(changes: Record<string, unknown>): Promise<void> {
        const engine = this.options.files?.fs;
        const nodeId = editorFilePath(this.options);
        if (!engine || !nodeId) return;
        await engine.driver.updateMetadata(nodeId, changes);
    }

    /**
     * Sync node name to the engine so vfs-ui refreshes its list display.
     * Safe to call without engine — no-ops silently.
     */
    protected async syncName(newName: string): Promise<void> {
        const engine = this.options.files?.fs;
        const nodeId = editorFilePath(this.options);
        if (!engine || !nodeId || !newName) return;
        await engine.driver.rename(nodeId, newName);
    }

    protected trackAutoSave(save: SettingsAutoSave): void { this.autoSaves.add(save); }

    protected bindAutoSave(root: HTMLElement, save: SettingsSave, statusHost?: HTMLElement): SettingsAutoSave {
        const controller = new SettingsAutoSave(root, save, statusHost);
        this.trackAutoSave(controller); return controller;
    }

    protected async prepareRender(): Promise<boolean> {
        for (const save of this.autoSaves) {
            if (!await save.dispose()) return false;
            this.autoSaves.delete(save);
        }
        return true;
    }

    protected async discardAutoSave(): Promise<void> {
        await Promise.all([...this.autoSaves].map(save => save.dispose(false)));
        this.autoSaves.clear();
    }

    abstract render(): void | Promise<void>;

    focus() { }

    protected addEventListener(target: EventTarget | null, type: string, handler: EventListener) {
        if (target) {
            target.addEventListener(type, handler);
            this.listeners.push({ target, type, handler });
        }
    }

    protected clearListeners() {
        this.listeners.forEach(listener => {
            listener.target.removeEventListener(listener.type, listener.handler);
        });
        this.listeners = [];
    }

    // --- IEditor Stubs ---
    async flushPendingSave(): Promise<void> {
        for (const save of this.autoSaves) {
            if (!await save.flush()) throw new Error(t('settings.autosave.leaveFailed'));
        }
    }

    async destroy() {
        if (!await this.prepareRender()) throw new Error(t('settings.autosave.leaveFailed'));
        this.clearListeners();
        this.container.innerHTML = '';
    }

    getText() { return ''; }
    setText(_text: string) { }

    getMode(): 'edit' | 'render' { return 'render'; }
    async switchToMode(_mode: 'edit' | 'render') { }
    setTitle(_title: string) { }
    setReadOnly(_readOnly: boolean) { }
    isDirty() { return [...this.autoSaves].some(save => save.isDirty); }
    setDirty(_dirty: boolean) { }

    get commands() { return {}; }
    async getHeadings(): Promise<Heading[]> { return []; }
    async getSearchableText(): Promise<string> { return ''; }
    async getSummary(): Promise<string | null> { return null; }
    async navigateTo(_target: { elementId: string }) { }
    async search(_query: string): Promise<UnifiedSearchResult[]> { return []; }
    gotoMatch(_result: UnifiedSearchResult) { }
    clearSearch() { }

    async collapseBlocks(): Promise<CollapseExpandResult> {
        return { affectedCount: 0, allCollapsed: true };
    }

    async expandBlocks(): Promise<CollapseExpandResult> {
        return { affectedCount: 0, allCollapsed: false };
    }

    async toggleBlocks(): Promise<CollapseExpandResult> {
        return this.collapseBlocks();
    }

    async pruneAssets(): Promise<number | null> {
        return null; // 设置页面通常没有附件需要清理
    }

    on<E extends EditorEvent>(
        _eventName: E,
        _callback: EditorEventCallback<E>,
    ): () => void {
        return () => {};
    }

    // ── Entity header helpers (shared by Skill, MCP, and future entity editors) ──

    /**
     * Renders the standard entity detail-panel header:
     *   [icon] [name input] [badges]          [actions]
     *          [subtitle]
     *
     * Pass `editableIcon: true` to render an editable <input> for the icon;
     * otherwise a static <span> is rendered.
     */
    protected renderEntityHeader(opts: {
        icon: string;
        fallbackIcon: string;
        editableIcon?: boolean;
        name: string;
        namePlaceholder?: string;
        badges?: string;
        subtitle?: string;
        actions?: string;
    }): string {
        const displayIcon = opts.icon || opts.fallbackIcon;
        const iconEl = opts.editableIcon
            ? `<input type="hidden" name="header-icon" value="${escapeAttr(opts.icon)}">
               <button type="button" data-action="icon-picker-toggle" data-fallback-icon="${escapeAttr(opts.fallbackIcon)}"
                   title="${t('tooltip.clickEditIcon')}"
                   style="font-size:2rem;width:2.75rem;height:2.75rem;text-align:center;
                          border:2px solid transparent;border-radius:8px;background:transparent;
                          cursor:pointer;outline:none;padding:0;font-family:inherit;flex-shrink:0;
                          transition:border-color .15s;line-height:1">${displayIcon}</button>
               <div data-role="icon-picker-popover" style="display:none;position:absolute;top:100%;left:0;
                    margin-top:4px;z-index:100;background:var(--st-surface,#fff);
                    border:1px solid var(--st-border-color);border-radius:10px;
                    box-shadow:0 8px 24px rgba(0,0,0,.12);padding:1rem;min-width:340px">
                   <!-- paste area -->
                   <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
                       <span style="font-size:.8125rem;white-space:nowrap;color:var(--st-text-secondary)">${t('iconPicker.pasteLabel')}</span>
                       <input data-role="icon-picker-input" placeholder="${t('iconPicker.pastePlaceholder')}"
                           style="flex:1;padding:.25rem .5rem;font-size:.875rem;border:1px solid var(--st-border-color);
                                  border-radius:6px;outline:none;font-family:inherit"
                           maxlength="4">
                       <button type="button" data-action="icon-picker-confirm"
                           style="padding:.25rem .625rem;font-size:.75rem;font-weight:600;border:1px solid var(--st-primary,#6366f1);
                                  border-radius:6px;background:var(--st-primary,#6366f1);color:#fff;cursor:pointer">
                           ${t('action.confirm')}
                       </button>
                   </div>
                   <div style="border-top:1px solid var(--st-border-color);margin-bottom:.75rem"></div>
                   <!-- emoji grid -->
                   <div style="font-size:.8125rem;color:var(--st-text-secondary);margin-bottom:.375rem">${t('iconPicker.systemLabel')}</div>
                   <div data-role="icon-picker-grid" style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-bottom:.75rem">
                       ${SYSTEM_ICONS.map(e => `<button type="button" data-action="icon-pick" data-emoji="${e}"
                           style="font-size:1.125rem;padding:4px;text-align:center;border:1px solid transparent;
                                  border-radius:6px;background:transparent;cursor:pointer;line-height:1.4;
                                  transition:background .12s"
                           title="${e}">${e}</button>`).join('')}
                   </div>
                   <div style="border-top:1px solid var(--st-border-color);margin-bottom:.75rem"></div>
                   <!-- clear -->
                   <button type="button" data-action="icon-picker-clear"
                       style="padding:.375rem .75rem;font-size:.8125rem;border:1px solid var(--st-border-color);
                              border-radius:6px;background:transparent;cursor:pointer;color:var(--st-text-secondary);
                              width:100%;text-align:center">
                       🗑️ ${t('iconPicker.useDefault')}
                   </button>
               </div>`
            : `<span style="font-size:2.25rem;flex-shrink:0;line-height:1">${displayIcon}</span>`;

        return `
            <div style="padding:1.25rem 1.75rem;border-bottom:1px solid var(--st-border-color);
                        display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap">
                <div style="display:flex;align-items:center;gap:1rem;min-width:0">
                    <span style="position:relative;display:inline-flex;flex-shrink:0">${iconEl}</span>
                    <div style="min-width:0">
                        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                            <input name="header-name" required value="${opts.name}"
                                placeholder="${opts.namePlaceholder ?? ''}"
                                style="font-size:1.125rem;font-weight:700;color:var(--st-text-primary);
                                       background:transparent;border:0;border-bottom:2px solid transparent;
                                       outline:none;padding:0 0 1px;font-family:inherit;
                                       width:auto;min-width:60px;max-width:280px;cursor:text;
                                       transition:border-color .15s"
                                title="${t('tooltip.clickEditName')}">
                            ${opts.badges ?? ''}
                        </div>
                        ${opts.subtitle ? `
                        <div style="font-size:.8125rem;color:var(--st-text-secondary);margin-top:.125rem">
                            ${opts.subtitle}
                        </div>` : ''}
                    </div>
                </div>
                ${opts.actions ? `<div style="display:flex;gap:.5rem;flex-shrink:0">${opts.actions}</div>` : ''}
            </div>`;
    }

    /**
     * Binds focus/blur/keydown on [name="header-name"] and optionally [name="header-icon"].
     * Must be called after every render that includes renderEntityHeader().
     *
     * @param onNameSave - Called on blur with the trimmed new name (skip if falsy or unchanged).
     * @param onIconSave - Called on blur with the trimmed new icon value (only when editableIcon).
     * @param mirrorNameSelector - CSS selector of a secondary input to keep in sync with header-name.
     */
    protected bindEntityHeaderEvents(opts: {
        onNameSave?: (newName: string) => Promise<void>;
        onIconSave?: (newIcon: string) => Promise<void>;
        mirrorNameSelector?: string;
    } = {}): void {
        const nameInput = this.container.querySelector<HTMLInputElement>('[name="header-name"]');
        if (nameInput) {
            this.addEventListener(nameInput, 'focus', () => {
                nameInput.style.borderBottomColor = 'var(--st-primary, #6366f1)';
            });
            this.addEventListener(nameInput, 'blur', async () => {
                nameInput.style.borderBottomColor = 'transparent';
                if (opts.onNameSave) await opts.onNameSave(nameInput.value.trim());
            });
            this.addEventListener(nameInput, 'keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter')  nameInput.blur();
                if ((e as KeyboardEvent).key === 'Escape') nameInput.blur();
            });
            if (opts.mirrorNameSelector) {
                const mirror = this.container.querySelector<HTMLInputElement>(opts.mirrorNameSelector);
                if (mirror) {
                    this.addEventListener(nameInput, 'input', () => {
                        mirror.value = nameInput.value;
                        this.resizeHeaderInput(nameInput);
                    });
                    this.addEventListener(mirror, 'input', () => {
                        nameInput.value = mirror.value;
                        this.resizeHeaderInput(nameInput);
                    });
                }
            }
            this.resizeHeaderInput(nameInput);
        }

        // ── Icon picker ─────────────────────────────────────────────────────
        const toggleBtn = this.container.querySelector<HTMLButtonElement>('[data-action="icon-picker-toggle"]');
        const popover    = this.container.querySelector<HTMLElement>('[data-role="icon-picker-popover"]');
        if (!toggleBtn || !popover || !opts.onIconSave) return;

        const pickerInput = popover.querySelector<HTMLInputElement>('[data-role="icon-picker-input"]');

        const close = () => { popover.style.display = 'none'; };
        const open  = () => { popover.style.display = 'block'; if (pickerInput) pickerInput.value = ''; };
        const isOpen = () => popover.style.display !== 'none';

        const selectIcon = async (emoji: string) => {
            const trimmed = emoji.trim();
            const icon = this.container.querySelector<HTMLInputElement>('[name="header-icon"]');
            if (icon) icon.value = trimmed;
            toggleBtn.textContent = trimmed || toggleBtn.dataset.fallbackIcon || '';
            close();
            await opts.onIconSave!(trimmed);
        };

        // Toggle on button click
        this.addEventListener(toggleBtn, 'click', (e) => {
            e.stopPropagation();
            isOpen() ? close() : open();
        });

        // Pick from grid
        popover.querySelectorAll<HTMLButtonElement>('[data-action="icon-pick"]').forEach(btn => {
            this.addEventListener(btn, 'click', (e) => {
                e.stopPropagation();
                selectIcon(btn.dataset.emoji ?? '');
            });
        });

        // Confirm paste input
        const confirmBtn = popover.querySelector<HTMLButtonElement>('[data-action="icon-picker-confirm"]');
        if (confirmBtn && pickerInput) {
            this.addEventListener(confirmBtn, 'click', (e) => {
                e.stopPropagation();
                if (pickerInput.value.trim()) selectIcon(pickerInput.value);
            });
            this.addEventListener(pickerInput, 'keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter' && pickerInput.value.trim()) {
                    e.stopPropagation();
                    selectIcon(pickerInput.value);
                }
            });
        }

        // Clear → use default
        const clearBtn = popover.querySelector<HTMLButtonElement>('[data-action="icon-picker-clear"]');
        if (clearBtn) {
            this.addEventListener(clearBtn, 'click', (e) => {
                e.stopPropagation();
                selectIcon('');
            });
        }

        // Close on outside click
        const onClickOutside = (e: MouseEvent) => {
            if (!isOpen()) return;
            if (!popover.contains(e.target as Node) && e.target !== toggleBtn) {
                close();
            }
        };
        document.addEventListener('click', onClickOutside);
        this.listeners.push({
            target: document,
            type: 'click',
            handler: onClickOutside as EventListener,
        });
    }

    /** Auto-sizes an input to its content width (max 280px). */
    protected resizeHeaderInput(input: HTMLInputElement): void {
        input.style.width = '4px';
        input.style.width = `${Math.min(input.scrollWidth + 4, 280)}px`;
    }

    /**
     * Replaces a sidebar title element with an inline rename <input>.
     * Commits on blur/Enter; cancels on Escape.
     * Uses the shared CSS class `settings-inline-rename` — list click handlers
     * should guard against this class to prevent inadvertent item selection.
     *
     * @param titleEl  - The element showing the current name (will be cleared).
     * @param onCommit - Async save callback; receives the confirmed new name.
     * @param onAfterCommit - Optional sync DOM patch after a successful commit.
     */
    protected startInlineRename(
        titleEl: HTMLElement,
        onCommit: (newName: string) => Promise<void>,
        onAfterCommit?: (newName: string) => void,
    ): void {
        if (titleEl.querySelector('input')) return;
        const original = titleEl.textContent?.trim() ?? '';

        const input = document.createElement('input');
        input.value = original;
        input.className = 'settings-inline-rename';
        input.style.cssText = [
            'width:100%', 'padding:0 2px', 'margin:0',
            'font-size:inherit', 'font-weight:inherit', 'font-family:inherit',
            'color:inherit', 'background:var(--st-input-bg,#fff)',
            'border:1px solid var(--st-primary,#6366f1)', 'border-radius:3px',
            'outline:none', 'line-height:1.4',
        ].join(';');

        titleEl.textContent = '';
        titleEl.appendChild(input);
        input.select();
        input.focus();

        let committed = false;
        const commit = async () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim() || original;
            titleEl.textContent = newName;
            if (newName !== original) {
                await onCommit(newName);
                onAfterCommit?.(newName);
            }
        };

        input.addEventListener('blur', commit as EventListener, { once: true });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { input.blur(); }
            if (e.key === 'Escape') {
                input.removeEventListener('blur', commit as EventListener);
                committed = true;
                titleEl.textContent = original;
            }
        });
    }

}
