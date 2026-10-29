import {resolveResize} from '@itookit/image-parser';
import {t} from '@itookit/common';
import {renderParameterFields, readParameterFields, type FormParameter} from '@itookit/llm-ui/forms';
import type {SelectorView, ChatView} from '@itookit/llm-ui';
import type {ChatInputSettings} from '../domain/ports/IChatInputPresenter';
import type {ConnectionOption} from '../domain/types';

const booleans = ['streamMode', 'thinkingEnabled', 'webSearchEnabled'] as const;
const numbers = ['temperature', 'historyLength'] as const;
const strings = ['connectionId', 'modelTier', 'executionMode', 'reasoningEffort', 'systemPromptAppend'] as const;
/** Only known presentation preferences cross into Session execution settings. */
export function chatSettings(selection: Readonly<Record<string, string>> | undefined, base: ChatInputSettings = {}): ChatInputSettings {
    const result = {...base};
    for (const key of booleans) if (selection && Object.hasOwn(selection, key)) result[key] = selection[key] === 'true' ? true : selection[key] === 'false' ? false : undefined;
    for (const key of numbers) if (selection && Object.hasOwn(selection, key)) {
        const value = selection[key]; if (value && !Number.isFinite(Number(value))) throw new Error('Invalid numeric chat preference');
        result[key] = value === '' ? undefined : Number(value);
    }
    for (const key of strings) if (selection && Object.hasOwn(selection, key)) Object.assign(result, {[key]: selection[key] || undefined});
    if (selection?.imageResize) result.imageResize = resolveResize(JSON.parse(selection.imageResize));
    if (base.executionModeLocked) result.executionMode = base.executionMode;
    return result;
}
export function chatSelectors(connections: readonly ConnectionOption[], settings: ChatInputSettings): SelectorView[] {
    const follow = {id: '', label: t('chatSettings.followDefault')};
    const variants = Object.fromEntries(['', ...connections.map(item => item.id)].map(id => {
        const connection = connections.find(item => id ? item.id === id : item.isDefault);
        const choices = (['auto', 'optimal', 'standard', 'fast'] as const).flatMap(tier => {
            const model = connection?.resolvedTiers?.[tier === 'auto' ? 'optimal' : tier as 'optimal' | 'standard' | 'fast'];
            return tier === 'auto' || model ? [{id: tier, label: tier === 'auto' ? follow.label : `${model} · ${t(`ocr.tier.${tier}`)}`}] : [];
        });
        return [id, {value: settings.modelTier ?? 'auto', choices}];
    }));
    return [{id: 'connectionId', label: t('chatInput.model'), value: settings.connectionId ?? '', choices: [follow,
        ...connections.filter(item => item.enabled !== false && item.credentialsReady !== false).map(item => ({id: item.id, label: `${item.name}${item.providerName ? ' · ' + item.providerName : ''}`}))]},
        {id: 'modelTier', label: t('chatSettings.tier'), value: settings.modelTier ?? 'auto', choices: [], variants: {selectorId: 'connectionId', values: variants}},
        ...(!settings.executionModeLocked ? [{id: 'executionMode', label: t('chatInput.executionMode.agent'), value: settings.executionMode ?? 'chat', disabled: settings.executionModeLocked,
            choices: [{id: 'chat', label: t('chatInput.executionMode.chat')}, {id: 'agent', label: t('chatInput.executionMode.agent')}]}] : [])];
}
export function mountChatSettings(root: HTMLElement, view: () => ChatView | undefined, settings: () => ChatInputSettings, error: (error: unknown) => void) {
    const details = document.createElement('details'), summary = document.createElement('summary'), form = document.createElement('form');
    details.className = 'llm-chat__host-menu'; details.dataset.chatSettings = ''; summary.textContent = t('chatSettings.title');
    const fields: FormParameter[] = [
        {name: 'historyLength', type: 'number', label: t('chatSettings.history'), integer: true, minimum: -1},
        {name: 'temperature', type: 'number', label: t('agent.layout.temperature'), minimum: 0, maximum: 2},
        {name: 'streamMode', type: 'boolean', label: t('flow.settings.streaming')},
        {name: 'thinkingEnabled', type: 'boolean', label: t('thinking.label')},
        {name: 'webSearchEnabled', type: 'boolean', label: t('webSearch.label')},
        {name: 'reasoningEffort', type: 'string', label: t('thinking.effort.label'), options: ['auto', 'low', 'medium', 'high', 'xhigh']},
        {name: 'systemPromptAppend', type: 'string', widget: 'textarea', label: t('chatSettings.instructions')},
    ];
    const apply = document.createElement('button'), feedback = document.createElement('p'); apply.type = 'submit'; apply.textContent = t('action.save');
    details.append(summary, form); root.append(details);
    details.ontoggle = () => {if (details.open) {form.innerHTML = renderParameterFields(fields, {mode: 'defaults', values: settings()}); form.append(apply, feedback);}};
    form.onsubmit = event => {
        event.preventDefault(); const current = view(); if (!current) return;
        try {
            const values = readParameterFields(form, fields, {mode: 'defaults'}), draft = current.getDraft();
            const selection = {...draft.selection, ...Object.fromEntries(fields.map(field => [field.name, values[field.name] === undefined ? '' : String(values[field.name])]))};
            current.configureInput({selection}, draft.revision); details.open = false; feedback.textContent = '';
        } catch (failure) {feedback.textContent = String(failure); error(failure);}
    };
    return () => {details.remove();};
}
