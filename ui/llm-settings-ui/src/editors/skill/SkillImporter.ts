// @file llm-ui/editors/skill/SkillImporter.ts
// Import/export/batch operations for SkillSettingsEditor.
// Frequently modified: format support, import strategy, export options.

import {generateShortUUID, t} from '@itookit/common';
import { Modal } from '@itookit/ui-common';
import type { LLMSkill, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Toast } from '@itookit/ui-common';
import yaml from 'js-yaml';

export interface SkillImporterDeps {
    service: IAgentManagementService;
    render: () => Promise<void>;
    get selectedId(): string | null;
    set selectedId(id: string | null);
    get importing(): boolean;
    set importing(v: boolean);
    get checkedIds(): Set<string>;
    set checkedIds(ids: Set<string>);
}

export function showImport(deps: SkillImporterDeps): void {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,.yaml,.yml,application/json';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);

    fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files ?? []);
        document.body.removeChild(fileInput);
        if (files.length === 0) return;

        const results = await Promise.allSettled(
            files.map(f => f.text()),
        );

        const skills: LLMSkill[] = [];
        const errors: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'rejected') {
                errors.push(t('skill.import.readError', { filename: files[i].name }));
                continue;
            }
            try {
                const name = files[i].name;
                const isYaml = name.endsWith('.yaml') || name.endsWith('.yml');
                const data = isYaml ? yaml.load(r.value) : JSON.parse(r.value);
                const arr: LLMSkill[] = Array.isArray(data) ? data as LLMSkill[] : [data as LLMSkill];
                skills.push(...arr);
            } catch {
                errors.push(`${files[i].name}: ${t('skill.toast.invalidJson')}`);
            }
        }

        if (errors.length > 0) Toast.error(errors.join('\n'));
        if (skills.length === 0) return;

        deps.importing = true;
        const existingIds = new Set((await deps.service.getSkills()).map(s => s.id));
        let lastId = '';
        let savedCount = 0;
        for (const item of skills) {
            let baseId = item.id ?? `skill-${generateShortUUID()}`;
            if (existingIds.has(baseId)) {
                let counter = 2;
                while (existingIds.has(`${baseId}-${counter}`)) counter++;
                const suffixed = `${baseId}-${counter}`;
                errors.push(`ID "${baseId}" already exists → renamed to "${suffixed}"`);
                baseId = suffixed;
            }
            item.id = baseId;
            existingIds.add(baseId);
            item.enabled = item.enabled ?? false;
            try {
                await deps.service.saveSkill(item);
                lastId = item.id;
                savedCount++;
            } catch (e) {
                errors.push(`${item.name || item.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        deps.importing = false;

        if (errors.length > 0) Toast.error(errors.join('\n'));
        if (savedCount > 0) Toast.success(t('skill.toast.imported', { count: savedCount }));
        if (lastId) deps.selectedId = lastId;
        await deps.render();
    });

    fileInput.addEventListener('cancel', () => {
        if (fileInput.parentNode) document.body.removeChild(fileInput);
    });

    fileInput.click();
}

export function showPasteImport(deps: SkillImporterDeps): void {
    const body = `
        <p style="font-size:.875rem;color:var(--st-text-secondary);margin:0 0 .75rem">
            ${t('dialog.import.hint')}</p>
        <textarea class="settings-textarea" id="import-json" rows="8"
            style="font-family:monospace;font-size:.8125rem"
            placeholder='[{"name":"My Skill","type":"prompt","instructions":"..."}]'></textarea>`;
    new Modal(t('skill.import.title'), body, {
        confirmText: t('dialog.import.action'),
        onConfirm: async () => {
            const text = (document.getElementById('import-json') as HTMLTextAreaElement)?.value ?? '';
            let arr: LLMSkill[];
            try {
                const looksLikeYaml = text.trimStart().startsWith('---') ||
                    /^[a-zA-Z_][\w]*\s*:/m.test(text.trimStart().slice(0, 120));
                const data = looksLikeYaml ? yaml.load(text) : JSON.parse(text);
                arr = Array.isArray(data) ? data as LLMSkill[] : [data as LLMSkill];
            } catch {
                Toast.error(t('skill.toast.invalidJson'));
                return false;
            }

            deps.importing = true;
            const saveErrors: string[] = [];
            let savedCount = 0;
            for (const item of arr) {
                item.id = item.id ?? `skill-${generateShortUUID()}`;
                item.enabled = item.enabled ?? false;
                try {
                    await deps.service.saveSkill(item);
                    savedCount++;
                } catch (e) {
                    saveErrors.push(`${item.name || item.id}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            deps.importing = false;

            if (saveErrors.length > 0) Toast.error(saveErrors.join('\n'));
            if (savedCount > 0) {
                Toast.success(t('skill.toast.imported', { count: savedCount }));
                deps.selectedId = [...arr].reverse().find((s) => s.id)?.id ?? deps.selectedId;
            }
            await deps.render();
        },
    }).show();
}

export async function exportAll(deps: SkillImporterDeps): Promise<void> {
    const skills = await deps.service.getSkills();
    downloadYaml(skills, 'skills.yaml');
}

export async function batchDelete(deps: SkillImporterDeps): Promise<void> {
    const ids = [...deps.checkedIds];
    if (ids.length === 0) return;
    Modal.confirm(
        t('dialog.delete.title'),
        `Delete ${ids.length} selected skill${ids.length > 1 ? 's' : ''}?`,
        async () => {
            deps.importing = true;
            for (const id of ids) await deps.service.deleteSkill(id).catch(() => {});
            deps.importing = false;
            deps.checkedIds = new Set();
            if (ids.includes(deps.selectedId ?? '')) deps.selectedId = null;
            await deps.render();
        },
    );
}

export async function batchExport(deps: SkillImporterDeps): Promise<void> {
    const ids = new Set(deps.checkedIds);
    if (ids.size === 0) return;
    const all = await deps.service.getSkills();
    const selected = all.filter(s => ids.has(s.id));
    downloadYaml(selected, selected.length === 1 ? `${selected[0].id}.yaml` : 'skills-export.yaml');
}

export function downloadYaml(skills: LLMSkill[], filename: string): void {
    const content = yaml.dump(skills, { lineWidth: -1, noRefs: true });
    const blob = new Blob([content], { type: 'text/yaml' });
    const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob), download: filename,
    });
    a.click();
    URL.revokeObjectURL(a.href);
}
