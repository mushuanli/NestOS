import { escapeHTML, randomUUID, t } from '@itookit/common';
import type { OcrService } from '@itookit/app-contracts/services';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { Modal } from '@itookit/ui-common';

/** Edit the referenced shared prompt without leaving the defaults page. */
export async function editOcrPrompt(service: OcrService, agents: IAgentManagementService): Promise<void> {
    const operationId = randomUUID(), started = performance.now();
    try {
        const id = await service.preparePromptEditor(), prompt = await agents.getSystemPrompt(id);
        if (!prompt) throw new Error(t('ocr.promptMissing', { id }));
        const original = prompt.content.join('\n\n'), fieldId = 'ocr-prompt-' + operationId;
        return await new Promise<void>(resolve => {
            new Modal(t('ocr.prompt'), `<div class="settings-form__group"><label class="settings-form__label" for="${fieldId}">${t('ocr.prompt')}</label>
                <textarea class="settings-form__textarea" id="${fieldId}" data-ocr-prompt rows="10">${escapeHTML(original)}</textarea></div>`, {
                width: '640px', confirmText: t('action.save'), cancelText: t('action.cancel'), onCancel: resolve,
                onConfirm: async element => {
                    const value = element.querySelector<HTMLTextAreaElement>('[data-ocr-prompt]')!.value;
                    if (value !== original) await savePrompt(agents, id, value, prompt.content);
                    resolve();
                },
            }).show();
        });
    } catch (error) { logFailure('read', operationId, started, error); throw error; }
}

async function savePrompt(agents: IAgentManagementService, id: string, value: string, previous: string[]): Promise<void> {
    const operationId = randomUUID(), started = performance.now();
    let stage = 'validation';
    try {
        if (!value.trim()) throw new Error(t('ocr.promptEmpty'));
        stage = 'read';
        const current = await agents.getSystemPrompt(id);
        if (!current) throw new Error(t('ocr.promptMissing', { id }));
        if (JSON.stringify(current.content) !== JSON.stringify(previous)) throw new Error(t('ocr.promptChanged'));
        stage = 'persistence';
        await agents.saveSystemPrompt({ ...current, content: [value] });
        console.info('ocr.prompt.save', { operation: 'ocr.prompt.save', operationId, stage, outcome: 'success', durationMs: Math.round(performance.now() - started) });
    } catch (error) { logFailure(stage, operationId, started, error); throw error; }
}

function logFailure(stage: string, operationId: string, started: number, error: unknown): void {
    console.error('ocr.prompt.failed', { operation: 'ocr.prompt.edit', operationId, stage, outcome: 'failure',
        code: 'OCR_PROMPT_' + stage.toUpperCase() + '_FAILED', errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - started) });
}
