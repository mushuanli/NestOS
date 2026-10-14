// @file: llm-settings-ui/editors/SystemPromptSettingsEditor.ts
import { BaseSettingsEditor, Modal, Toast, SettingsValidationError, requestSettingsSave } from '@itookit/ui-common';
import { editorResourceId } from '@itookit/ui-common';
import { t, TOOLBOX_ICONS, escapeHTML } from '@itookit/common';
import { type SystemPromptDefinition, type PromptPreset } from '@itookit/tools/contracts';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';

export class SystemPromptSettingsEditor extends BaseSettingsEditor<IAgentManagementService> {
    private prompts: SystemPromptDefinition[] = [];
    private selectedId: string | null = null;

    private get formOnly(): boolean { return this.options.target?.kind === 'entity' && this.options.target.entityType === 'system-prompt'; }

    async render(): Promise<void> {
        if (!await this.prepareRender()) return;
        this.prompts = await this.service.listSystemPrompts();
        if (this.formOnly) {
            this.selectedId = editorResourceId(this.options) ?? null;
            const prompt = this.prompts.find(item => item.id === this.selectedId);
            this.container.innerHTML = prompt ? this.form(prompt) : `<p>${escapeHTML(t('prompt.missing', { id: this.selectedId ?? '' }))}</p>`;
            this.bind(); return;
        }
        if (this.selectedId && !this.prompts.some(p => p.id === this.selectedId)) this.selectedId = null;
        if (!this.selectedId && this.prompts.length) this.selectedId = this.prompts[0].id;
        const selected = this.prompts.find(p => p.id === this.selectedId) ?? null;
        this.container.innerHTML = `
            <div class="settings-split${selected ? ' has-detail' : ''}">
                <aside class="settings-split__sidebar">
                    <div class="settings-split__header">
                        <h3><i class="fas fa-align-left" style="margin-right:.5rem;opacity:.7"></i>系统提示词</h3>
                        <button class="settings-btn-round" data-action="new" title="新建" aria-label="新建系统提示词"><i class="fas fa-plus"></i></button>
                    </div>
                    <div class="settings-split__list">
                        ${this.prompts.length ? this.prompts.map(p => this.listItem(p)).join('') : this.emptyList()}
                    </div>
                </aside>
                <main class="settings-split__content" style="padding:0">
                    <button class="settings-mobile-back" data-action="back"><i class="fas fa-arrow-left"></i> 系统提示词</button>
                    ${selected ? this.form(selected) : this.emptyState()}
                </main>
            </div>`;
        this.bind();
    }

    private listItem(p: SystemPromptDefinition): string {
        const summary = p.description?.trim() || `${p.content?.length ?? 0} 段消息 · ${p.presets?.length ?? 0} 个快捷项`;
        return `<div class="settings-list-item ${p.id === this.selectedId ? 'selected' : ''}" data-sp-id="${escapeHTML(p.id)}" role="button" tabindex="0">
            <span class="settings-list-item__icon">${TOOLBOX_ICONS.prompts}</span>
            <div class="settings-list-item__info">
                <div class="settings-list-item__title">${escapeHTML(p.name || p.id)}</div>
                <div class="settings-list-item__desc" title="${escapeHTML(summary)}">${escapeHTML(summary)}</div>
            </div>
        </div>`;
    }

    private emptyList(): string {
        return `<div class="settings-empty settings-empty--mini">
            <div class="settings-empty__icon">${TOOLBOX_ICONS.prompts}</div><p>还没有系统提示词</p>
            <button class="settings-btn settings-btn--primary settings-btn--sm" data-action="new"><i class="fas fa-plus"></i> 创建第一个</button>
        </div>`;
    }

    private emptyState(): string {
        return `<div class="settings-empty" style="min-height:100%;justify-content:center;padding:2rem">
            <div class="settings-empty__icon">${TOOLBOX_ICONS.prompts}</div><h3 class="settings-empty__title">创建可复用的系统提示词</h3>
            <p style="max-width:28rem;text-align:center;color:var(--st-text-secondary);line-height:1.6">集中维护角色设定、行为约束和常用指令，在不同 Agent 之间快速复用。</p>
            <button class="settings-btn settings-btn--primary" data-action="new"><i class="fas fa-plus"></i> 新建系统提示词</button>
        </div>`;
    }

    private form(p: SystemPromptDefinition): string {
        const content = (p.content ?? []).join('\n');
        return `<header style="display:flex;align-items:center;gap:1rem;padding:1.25rem 1.75rem;border-bottom:1px solid var(--st-border-color)">
            <div style="width:2.75rem;height:2.75rem;border-radius:.75rem;display:grid;place-items:center;background:var(--st-color-primary-bg,#eef2ff);color:var(--st-color-primary);font-size:1.25rem">${TOOLBOX_ICONS.prompts}</div>
            <div style="min-width:0;flex:1"><h2 data-title style="margin:0;font-size:1.125rem">${escapeHTML(p.name || '未命名提示词')}</h2>
                <p style="margin:.25rem 0 0;color:var(--st-text-tertiary);font-size:.8125rem">${t('settings.autosave.hint')}</p></div>
            ${p.id ? `<button class="settings-btn settings-btn--danger" data-action="delete" title="删除"><i class="fas fa-trash"></i></button>` : ''}

        </header>
        <div style="overflow-y:auto;padding:1.5rem 1.75rem 2.5rem"><div style="max-width:900px;margin:auto">
            <section class="settings-section">
                <h3 class="settings-section__title" style="margin-bottom:.35rem">基本信息</h3>
                <p style="margin:0 0 1rem;color:var(--st-text-tertiary);font-size:.8125rem">用清晰的名称和描述帮助团队快速识别用途。</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.875rem">
                    <div class="settings-form-group"><label for="sp-name">名称</label><input class="settings-input" id="sp-name" data-field="name" value="${escapeHTML(p.name)}" placeholder="例如：高级编程助手"></div>
                    <div class="settings-form-group"><label for="sp-id">ID <small style="font-weight:400;color:var(--st-text-tertiary)">保存后不可修改</small></label><input class="settings-input" id="sp-id" data-field="id" data-autosave-defer value="${escapeHTML(p.id)}" ${p.id ? 'disabled' : ''} placeholder="coding-expert"></div>
                </div>
                <div class="settings-form-group"><label for="sp-desc">描述 <small style="font-weight:400;color:var(--st-text-tertiary)">可选</small></label><input class="settings-input" id="sp-desc" data-field="description" value="${escapeHTML(p.description ?? '')}" placeholder="简要说明适用场景"></div>
            </section>
            <section class="settings-section">
                <h3 class="settings-section__title" style="margin-bottom:.35rem">提示词内容</h3>
                <p style="margin:0 0 1rem;color:var(--st-text-tertiary);font-size:.8125rem">${t('prompt.contentHint')}</p>
                <div class="settings-form-group"><label for="sp-content" style="display:flex;justify-content:space-between"><span>System 消息</span><span data-count style="font-weight:400;color:var(--st-text-tertiary)">${t('prompt.lines', { count: this.lineCount(content) })}</span></label>
                    <textarea class="settings-textarea" id="sp-content" data-field="content" rows="12" spellcheck="false" style="min-height:14rem;resize:vertical;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace" placeholder="你是一位经验丰富的软件工程师。&#10;优先给出简洁、可验证的解决方案。">${escapeHTML(content)}</textarea></div>
            </section>
            <section class="settings-section" style="margin-bottom:0">
                <div style="display:flex;align-items:start;gap:1rem;margin-bottom:1rem"><div style="flex:1"><h3 class="settings-section__title" style="margin:0 0 .35rem">快捷 Prompt</h3><p style="margin:0;color:var(--st-text-tertiary);font-size:.8125rem">显示在输入框的快捷选择中，不会被 Flow 节点引用。</p></div>
                    <button class="settings-btn settings-btn--secondary settings-btn--sm" data-action="add-preset"><i class="fas fa-plus"></i> 添加快捷项</button></div>
                <div data-presets style="display:grid;gap:.75rem">${p.presets?.length ? p.presets.map(x => this.presetRow(x)).join('') : this.emptyPresets()}</div>
            </section>
        </div></div>`;
    }

    private emptyPresets(): string {
        return `<div data-presets-empty style="padding:1.25rem;border:1px dashed var(--st-border-color);border-radius:.625rem;text-align:center;color:var(--st-text-tertiary);font-size:.8125rem">暂无快捷项，可按需添加常用用户提示词</div>`;
    }

    private presetRow(p: PromptPreset): string {
        return `<div data-preset-row style="display:grid;grid-template-columns:minmax(140px,.35fr) minmax(0,1fr) auto;gap:.75rem;align-items:end;padding:1rem;border:1px solid var(--st-border-color);border-radius:.625rem;background:var(--st-bg-secondary)">
            <div class="settings-form-group" style="margin:0"><label>名称</label><input class="settings-input" data-preset-name placeholder="例如：检查代码" value="${escapeHTML(p.name)}"></div>
            <div class="settings-form-group" style="margin:0"><label>提示词</label><textarea class="settings-textarea" data-preset-prompt rows="2" placeholder="输入要快速发送的提示词">${escapeHTML(p.prompt)}</textarea></div>
            <button class="settings-btn-round" data-action="remove-preset" title="移除" aria-label="移除快捷项" style="color:var(--st-color-danger,#dc2626)"><i class="fas fa-trash-alt"></i></button>
        </div>`;
    }

    private bind(): void {
        this.clearListeners();
        this.container.querySelectorAll<HTMLElement>('[data-sp-id]').forEach(item => {
            const select = () => { this.selectedId = item.dataset.spId!; void this.render(); };
            this.addEventListener(item, 'click', select);
            this.addEventListener(item, 'keydown', e => { if ((e as KeyboardEvent).key === 'Enter') select(); });
        });
        this.container.querySelectorAll('[data-action="new"]').forEach(btn => this.addEventListener(btn, 'click', () => this.showNew()));
        this.addEventListener(this.container.querySelector('[data-action="back"]'), 'click', () => { this.selectedId = null; void this.render(); });
        if (this.container.querySelector('[data-field="name"]')) {
            const editingId = this.selectedId;
            this.bindAutoSave(this.container.querySelector<HTMLElement>('.settings-split__content') ?? this.container,
                () => this.save(this.container.querySelector<HTMLInputElement>('[data-field="id"]')?.disabled ? this.field('id') : editingId), this.container.querySelector<HTMLElement>('header') ?? undefined);
        }
        this.addEventListener(this.container.querySelector('[data-action="delete"]'), 'click', () => this.remove());
        this.addEventListener(this.container.querySelector('[data-action="add-preset"]'), 'click', () => {
            const box = this.container.querySelector<HTMLElement>('[data-presets]');
            box?.querySelector('[data-presets-empty]')?.remove();
            box?.insertAdjacentHTML('beforeend', this.presetRow({ name: '', prompt: '' }));
            box?.querySelector<HTMLInputElement>('[data-preset-row]:last-child [data-preset-name]')?.focus();
            if (box) requestSettingsSave(box);
        });
        this.addEventListener(this.container.querySelector('[data-presets]'), 'click', e => {
            const btn = (e.target as HTMLElement).closest('[data-action="remove-preset"]');
            if (!btn) return;
            btn.closest('[data-preset-row]')?.remove();
            const box = this.container.querySelector<HTMLElement>('[data-presets]');
            if (box && !box.querySelector('[data-preset-row]')) box.innerHTML = this.emptyPresets();
            if (box) requestSettingsSave(box);
        });
        this.addEventListener(this.container.querySelector('[data-field="content"]'), 'input', () => {
            const count = this.container.querySelector<HTMLElement>('[data-count]');
            if (count) count.textContent = t('prompt.lines', { count: this.lineCount(this.field('content')) });
        });
        this.addEventListener(this.container.querySelector('[data-field="name"]'), 'input', e => {
            const title = this.container.querySelector<HTMLElement>('[data-title]');
            if (title) title.textContent = (e.target as HTMLInputElement).value.trim() || '未命名提示词';
        });
    }

    private async showNew(): Promise<void> {
        if (!await this.prepareRender()) return;
        this.selectedId = null;
        const split = this.container.querySelector('.settings-split');
        const main = this.container.querySelector<HTMLElement>('.settings-split__content');
        split?.classList.add('has-detail');
        if (!main) return;
        main.innerHTML = `<button class="settings-mobile-back" data-action="back"><i class="fas fa-arrow-left"></i> 系统提示词</button>${this.form({ id: '', name: '', content: [] })}`;
        this.bind();
        main.querySelector<HTMLInputElement>('[data-field="name"]')?.focus();
    }

    private async save(editingId: string | null): Promise<void> {
        const name = this.field('name').trim();
        if (!name) throw new SettingsValidationError(t('settings.autosave.invalid'));
        const id = editingId || this.field('id').trim() || this.slug(name) || `sp-${Date.now().toString(36)}`;
        const previous = this.prompts.find(item => item.id === id);
        if (!editingId && previous) throw new SettingsValidationError(t('settings.autosave.invalid'));
        const text = this.field('content');
        const content = previous && text === previous.content.join('\n') ? previous.content : text.trim() ? [text] : [];
        const presets = Array.from(this.container.querySelectorAll<HTMLElement>('[data-preset-row]')).map(row => ({
            name: row.querySelector<HTMLInputElement>('[data-preset-name]')?.value.trim() ?? '',
            prompt: row.querySelector<HTMLTextAreaElement>('[data-preset-prompt]')?.value.trim() ?? '',
        })).filter(row => row.name || row.prompt);
        if (presets.some(row => !row.name || !row.prompt)) throw new SettingsValidationError(t('settings.autosave.invalid'));
        const draft = { ...previous, id, name, content, description: this.field('description').trim() || undefined,
            presets: presets.length ? presets : undefined };
        await this.service.saveSystemPrompt(draft);
        this.prompts = this.prompts.filter(prompt => prompt.id !== id).concat(draft);
        const idField = this.container.querySelector<HTMLInputElement>('[data-field="id"]');
        if (idField) { idField.value = id; idField.disabled = true; }
        if (!this.selectedId || this.selectedId === editingId) this.selectedId = id;
        const label = [...this.container.querySelectorAll<HTMLElement>('[data-sp-id]')].find(element => element.dataset.spId === id)?.querySelector<HTMLElement>('.settings-list-item__title');
        if (label) label.textContent = name;
    }

    private async remove(): Promise<void> {
        const prompt = this.prompts.find(p => p.id === this.selectedId);
        if (!prompt) return;
        if (this.formOnly && this.options.hostContext?.requestDelete) {
            await this.discardAutoSave();
            void this.options.hostContext.requestDelete([{ kind: 'entity', entityType: 'system-prompt', id: prompt.id }])
                .then(() => this.render()).catch(error => Toast.error(String(error)));
            return;
        }
        Modal.confirm('确认删除', `确定要删除“${prompt.name || prompt.id}”吗？此操作无法撤销。`, async () => {
            try {
                await this.discardAutoSave();
                await this.service.deleteSystemPrompt(prompt.id);
                this.selectedId = null;
                Toast.success('系统提示词已删除');
                await this.render();
            } catch (error) { Toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`); }
        });
    }

    private field(name: string): string { return this.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field="${name}"]`)?.value ?? ''; }
    private lineCount(value: string): number { return value.split('\n').filter(s => s.trim()).length; }
    private slug(name: string): string { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
}
