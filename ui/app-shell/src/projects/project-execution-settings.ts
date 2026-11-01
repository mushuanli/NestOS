import {t} from '@itookit/common';
import type {ProjectService} from '@itookit/app-contracts/services';

/** Keep environment text in form controls; never interpolate it into markup. */
export async function projectExecutionSettings(remote: NonNullable<ProjectService['remoteMounts']>, id: string, signal: AbortSignal) {
    const settings = await remote.executionSettings(id, {signal, timeoutMs: 10000});
    const panel = document.createElement('div');
    const label = document.createElement('label'); label.textContent = t('remote.executionProfile');
    const select = document.createElement('select'); select.setAttribute('aria-label', t('remote.executionProfile'));
    const fallback = document.createElement('option'); fallback.value = ''; fallback.textContent = t('remote.executionDefault'); select.append(fallback);
    for (const profile of settings.profiles) {
        const option = document.createElement('option'); option.value = profile.id;
        option.textContent = profile.user ? `${profile.name} (${profile.user})` : profile.name; select.append(option);
    }
    if (settings.execution.profile && !settings.profiles.some(p => p.id === settings.execution.profile)) throw new Error(t('remote.executionProfileUnavailable'));
    select.value = settings.execution.profile ?? ''; label.append(select); panel.append(label);
    const fields = environmentFields(settings.execution.variables,'remote.executionHint'); panel.append(fields.panel);
    return {panel, save: async () => {
        const variables = parseEnvironment(fields.text.value);
        if (select.value === (settings.execution.profile ?? '') && JSON.stringify(variables) === JSON.stringify(settings.execution.variables)) return;
        await remote.setExecution(id, settings.project, {profile: select.value || null, variables}, {signal, timeoutMs: 10000});
        settings.project = {...settings.project,revision:settings.project.revision+1};
        settings.execution = {profile:select.value || null,variables};
    }};
}
export function environmentFields(variables: Record<string,string>, hintKey: Parameters<typeof t>[0]) {
    const panel = document.createElement('div'), label = document.createElement('label'); label.textContent = t('remote.executionVariables');
    const text = document.createElement('textarea'); text.rows = 10; text.setAttribute('aria-label',t('remote.executionVariables'));
    text.value = Object.entries(variables).map(([key,value]) => `${key}=${value}`).join('\n'); label.append(text); panel.append(label);
    const hint = document.createElement('p'); hint.textContent = t(hintKey); panel.append(hint);
    return {panel,text};
}
export function parseEnvironment(text: string): Record<string, string> {
    const entries = text.split('\n').filter(line => line.trim()).map(line => {
        const index = line.indexOf('='); const key = line.slice(0, index).trim();
        if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(t('remote.executionInvalidVariables'));
        return [key, line.slice(index + 1)] as const;
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error(t('remote.executionInvalidVariables'));
    return Object.fromEntries(entries);
}
