// @file llm-ui/editors/skill/SkillOperations.ts
// CRUD operations for SkillSettingsEditor — extracted for stability.
// Infrequently modified: operation patterns are stable; only types change.

import {generateShortUUID, t} from '@itookit/common';
import { Modal } from '@itookit/ui-common';
import type { LLMSkill, IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Toast } from '@itookit/ui-common';

export interface SkillOperationsDeps {
    service: IAgentManagementService;
    beforeDelete?: () => Promise<void>;
    container: HTMLElement;
    render: () => Promise<void>;
    val: (name: string) => string;
    chk: (name: string) => boolean;
    get selectedId(): string | null;
    set selectedId(id: string | null);
}

export async function addNew(deps: SkillOperationsDeps): Promise<void> {
    const skill: LLMSkill = {
        id:              `skill-${generateShortUUID()}`,
        name:            'New Skill',
        type:            'prompt',
        enabled:         false,
        description:     '',
        instructions:    '',
        tools:           [],
        triggerPatterns: [],
        autoLoad:        false,
        priority:        50,
        createdAt:       Date.now(),
        modifiedAt:      Date.now(),
    };
    await deps.service.saveSkill(skill);
    deps.selectedId = skill.id;
    await deps.render();
}

export function deleteCurrent(deps: SkillOperationsDeps): void {
    if (!deps.selectedId) return;
    Modal.confirm(t('dialog.delete.title'), t('skill.confirm.delete'), async () => {
        await deps.beforeDelete?.();
        await deps.service.deleteSkill(deps.selectedId!);
        deps.selectedId = null;
        Toast.success(t('skill.toast.deleted'));
        await deps.render();
    });
}

export async function testCurrent(deps: SkillOperationsDeps): Promise<void> {
    const skills = await deps.service.getSkills();
    const skill  = skills.find(s => s.id === deps.selectedId);
    if (!skill) return;
    if (skill.type === 'prompt') { Toast.info(t('skill.toast.testPrompt')); return; }
    if (skill.type === 'mcp')    { Toast.info(t('skill.toast.testMcp')); return; }
    if (skill.type !== 'http')   { Toast.error(t('skill.toast.testNotHttp')); return; }
    if (!skill.endpoint)         { Toast.error(t('skill.toast.testNoEndpoint')); return; }

    const btn = deps.container.querySelector<HTMLButtonElement>('[data-action="test"]');
    if (!btn) return;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('status.testing')}`;
    btn.disabled  = true;

    try {
        const res = await fetch(skill.endpoint, {
            method:  skill.method ?? 'POST',
            headers: { 'Content-Type': 'application/json', ...skill.headers },
            body:    JSON.stringify({}),
        });
        res.ok ? Toast.success(t('skill.toast.testSuccess', { status: res.status }))
               : Toast.error(t('skill.toast.testFailed', { status: res.status }));
    } catch (e: unknown) {
        Toast.error(t('skill.toast.testError', { message: (e as Error).message }));
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled  = false;
    }
}
