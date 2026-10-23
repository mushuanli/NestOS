import { t } from '@itookit/common';
import type { ConversationManifest } from '@itookit/llm-session/contracts';

/** Initial material is visible context, never a fabricated user message. */
export function sessionMaterialHeader(manifest: ConversationManifest): HTMLElement | undefined {
    const material = manifest.initialContext;
    if (!material) return;
    const details = document.createElement('details'); details.className = 'llm-session-material';
    const title = document.createElement('summary'); title.textContent = t('project.childInitialMaterial');
    const hint = document.createElement('p'); hint.textContent = t('project.childContextHint');
    const origin = document.createElement('small'); origin.textContent = t('flow.source.frozen', {branch: material.branch, count: material.messageIds.length});
    const text = document.createElement('pre'); text.textContent = typeof material.value === 'string' ? material.value : JSON.stringify(material.value, null, 2);
    details.append(title, hint, origin, text); return details;
}

export function mountSessionInputActions(input: HTMLElement, manifest: ConversationManifest, launch: () => Promise<unknown>): HTMLElement {
    const receiver = document.createElement('p'); receiver.className = 'llm-input-receiver';
    receiver.textContent = t('project.currentConversation', {name: manifest.title})
        + (manifest.parentSessionId ? ` · ${t(manifest.initialContext ? 'project.childInitialMaterial' : 'project.childNoHistory')}` : '');
    input.before(receiver);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'llm-input__flow-launch';
    button.textContent = t('flow.invoke.title'); button.title = t('flow.invoke.description');
    button.addEventListener('click', () => {
        button.disabled = true;
        void launch().finally(() => { button.disabled = false; });
    });
    input.querySelector('.llm-input__toolbar-left')?.append(button);
    return receiver;
}
