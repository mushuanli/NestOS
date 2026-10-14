// @file: llm-ui/components/input/SkillPanel.ts
// Skill 选择面板：列表渲染 + Load/Unload 切换 + 刷新。
// 从 ChatInputView 抽出，自包含，只依赖注入的 onRequestSkills/onLoadSkill/onUnloadSkill。

import { t } from '@itookit/common';
import type { SkillInfo } from '../../domain/types';
import { ChatInputTemplates } from '../templates/ChatInputTemplates';

export interface SkillPanelDeps {
    onConfigureCapabilities?: () => void;
    onRequestSkills?: () => Promise<SkillInfo[]>;
    onLoadSkill?: (skillId: string) => Promise<unknown>;
    onUnloadSkill?: (skillId: string) => Promise<void>;
}

export class SkillPanel {
    private readonly section: HTMLElement;
    private readonly list: HTMLElement;
    private skills: SkillInfo[] = [];
    private loading = false;

    constructor(
        container: HTMLElement,
        private readonly deps: SkillPanelDeps,
    ) {
        this.section = container.querySelector('.llm-input__skill-section')!;
        this.list = container.querySelector('.llm-input__skills-list')!;

        // Toggle checkbox drives load/unload.
        this.section.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            if (!target.matches('.llm-input__skill-btn')) return;
            const skillId = target.dataset.skill;
            if (!skillId) return;
            if (target.checked) this.load(skillId);
            else this.unload(skillId);
        });
        this.section.addEventListener('click', event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-skill-reload]');
            if (button?.dataset.skillReload) void this.load(button.dataset.skillReload);
        });

        container.querySelector('.llm-input__skills-refresh')
            ?.addEventListener('click', () => this.reload());
    }

    /** 用最新列表刷新（Shell 注入或 reload 拉取后调用）。 */
    refresh(skills: SkillInfo[]): void {
        this.skills = skills;
        this.render();
    }

    async reload(): Promise<void> {
        if (!this.deps.onRequestSkills || this.loading) return;
        this.loading = true;
        this.list.innerHTML = '<span class="llm-input__skills-empty">Loading…</span>';
        try {
            this.refresh(await this.deps.onRequestSkills());
        } catch {
            this.list.innerHTML = '<span class="llm-input__skills-empty">Failed to load skills</span>';
        } finally {
            this.loading = false;
        }
    }

    private render(): void {
        if (this.skills.length === 0) {
            this.list.innerHTML = '<span class="llm-input__skills-empty">No skills available</span>';
        } else this.list.innerHTML = this.skills.map(s => ChatInputTemplates.renderSkillItem(s)).join('');
        if (this.deps.onConfigureCapabilities) {
            const button = document.createElement('button'); button.type = 'button';
            button.textContent = t('skill.configureCapabilities');
            button.addEventListener('click', () => this.deps.onConfigureCapabilities?.()); this.list.append(button);
        }
    }

    private async load(skillId: string): Promise<void> {
        if (!this.deps.onLoadSkill) return;
        const previouslyLoaded = this.skills.find(skill => skill.id === skillId)?.loaded ?? false;
        const btn = Array.from(this.list.querySelectorAll<HTMLInputElement>('[data-skill]')).find(item => item.dataset.skill === skillId);
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        try {
            await this.deps.onLoadSkill(skillId);
            const skill = this.skills.find(s => s.id === skillId);
            if (skill) skill.loaded = true;
            await this.reload();
        } catch (e) {
            console.error('[SkillPanel] load failed:', e);
            if (btn) { btn.disabled = false; btn.checked = previouslyLoaded; }
            const notice = document.createElement('span'); notice.setAttribute('role', 'alert');
            notice.textContent = e instanceof Error ? e.message : String(e); this.list.append(notice);
        }
    }

    private async unload(skillId: string): Promise<void> {
        if (!this.deps.onUnloadSkill) return;
        const btn = Array.from(this.list.querySelectorAll<HTMLInputElement>('[data-skill]')).find(item => item.dataset.skill === skillId);
        if (btn) { btn.disabled = true; btn.textContent = 'Unloading…'; }
        try {
            await this.deps.onUnloadSkill(skillId);
            const skill = this.skills.find(s => s.id === skillId);
            if (skill) skill.loaded = false;
            await this.reload();
        } catch (e) {
            console.error('[SkillPanel] unload failed:', e);
            if (btn) { btn.disabled = false; btn.checked = true; }
            const notice = document.createElement('span'); notice.setAttribute('role', 'alert');
            notice.textContent = e instanceof Error ? e.message : String(e); this.list.append(notice);
        }
    }
}
