import { t } from '@itookit/common';
import type { LLMSkill } from '@itookit/kernel-adapters/contracts';
import type { SkillType } from '@itookit/tools/contracts';
import { SettingsValidationError } from '@itookit/ui-common';
import { readSkillSupportFields } from './SkillSupportFields';

type Value = (name: string) => string;
type Checked = (name: string) => boolean;

function parseObject(raw: string, message: string): Record<string, unknown> | undefined {
    if (!raw.trim()) return;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(message);
        return parsed;
    } catch { throw new SettingsValidationError(message); }
}

function readExecutable(type: SkillType, val: Value): Partial<LLMSkill> {
    const http = type === 'http';
    const headers = http ? parseObject(val('headers'), t('skill.toast.invalidHeaders')) : undefined;
    if (headers && Object.values(headers).some(value => typeof value !== 'string')) {
        throw new SettingsValidationError(t('skill.toast.invalidHeaders'));
    }
    const auth = val('auth-header').trim();
    return {
        instructions: type === 'prompt' ? val('instructions') : '',
        command: type === 'shell' ? val('command') || undefined : undefined,
        mcpServerId: type === 'mcp' ? val('mcpServerId') || undefined : undefined,
        mcpToolName: type === 'mcp' ? val('mcpToolName') || undefined : undefined,
        endpoint: http ? val('endpoint') || undefined : undefined,
        method: http ? (val('method') || 'POST') as LLMSkill['method'] : undefined,
        headers: http ? { ...headers as Record<string, string>, ...(auth ? { Authorization: auth } : {}) } : undefined,
        parameters: !['prompt', 'mcp'].includes(type) ? parseObject(val('parameters'), t('skill.toast.invalidParams')) : undefined,
    };
}

export function readSkillDraft(existing: LLMSkill, val: Value, chk: Checked): LLMSkill {
    const name = val('header-name').trim();
    if (!name) throw new SettingsValidationError(t('settings.autosave.invalid'));
    const type = val('type') as SkillType;
    const globs = val('globs').split('\n').map(value => value.trim()).filter(Boolean);
    const priority = Number(val('priority') || '50');
    if (!Number.isFinite(priority)) throw new SettingsValidationError(t('settings.autosave.invalid'));
    return {
        ...existing,
        id: val('id').trim() || existing.id, name, type,
        icon: val('header-icon') || undefined,
        description: val('description'), enabled: chk('enabled'),
        ...readExecutable(type, val),
        triggerStrategy: (val('triggerStrategy') || 'reference') as LLMSkill['triggerStrategy'],
        autoLoad: chk('autoLoad'), priority, globs: globs.length ? globs : undefined,
        ...readSkillSupportFields(val, chk),
        disableModelInvocation: chk('disableModelInvocation') || undefined,
        modifiedAt: Date.now(),
    };
}
