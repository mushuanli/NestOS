import { ACTION_ICONS, createModuleLogger, randomUUID, t } from '@itookit/common';
import type { EditorOptions } from '@itookit/ui-common';

export interface AgentHeaderController {
    cancelPendingAction(): void;
    destroy(): void;
}

const log = createModuleLogger('agent-settings');

/** Keep the same identity fields and action when the viewport changes. */
export function mountAgentHeader(root: HTMLElement, options: EditorOptions, flush: () => Promise<void>): AgentHeaderController {
    const navigation = root.querySelector<HTMLElement>('[data-agent-compact-navigation]')!;
    const cleanup = options.mountCompactNavigation?.(navigation);
    if (cleanup) root.dataset.editorMobileNavigation = 'embedded';
    const fallback = document.createElement('strong'); fallback.className = 'agent-mobile-header__title';
    if (!cleanup) navigation.append(fallback);
    const updateTitle = () => {fallback.textContent = root.querySelector<HTMLInputElement>('[name="name"]')?.value ?? '';};
    root.addEventListener('input', updateTitle); updateTitle();
    const media = typeof matchMedia === 'function' ? matchMedia('(max-width: 768px)') : undefined;
    const action = new AgentChatAction(root, options, flush);
    const responsive = () => {
        const mobile = !!media?.matches;
        const identity = root.querySelector<HTMLElement>('[data-agent-identity]')!;
        const host = root.querySelector<HTMLElement>(mobile ? '[data-agent-identity-slot]' : '.agent-header')!;
        host.prepend(identity); action.move(mobile);
    };
    media?.addEventListener('change', responsive); responsive();
    return {cancelPendingAction: () => action.cancel(), destroy() {
        action.destroy(); cleanup?.(); root.removeEventListener('input', updateTitle);
        media?.removeEventListener('change', responsive); delete root.dataset.editorMobileNavigation;
    }};
}

class AgentChatAction {
    private readonly button = document.createElement('button');
    private readonly label = document.createElement('span');
    private readonly status: HTMLElement;
    private busy = false;
    private mobile = false;
    private disposed = false;
    private revision = 0;

    constructor(private root: HTMLElement, private options: EditorOptions, private flush: () => Promise<void>) {
        this.status = root.querySelector<HTMLElement>('[data-agent-chat-status]')!;
        this.button.type = 'button'; this.button.className = 'agent-chat-button'; this.button.dataset.agentStartChat = '';
        this.label.className = 'agent-chat-button__label';
        const icon = document.createElement('span'); icon.className = 'agent-chat-button__icon';
        icon.innerHTML = ACTION_ICONS.chat; icon.setAttribute('aria-hidden', 'true'); this.button.append(icon, this.label);
        this.button.onclick = () => {void this.open();};
    }

    move(mobile: boolean): void {
        this.mobile = mobile;
        if (!this.options.onStartConversation) return;
        this.root.querySelector(mobile ? '[data-agent-compact-actions]' : '[data-agent-header-actions]')!.append(this.button);
        this.update();
    }

    private update(): void {
        this.button.disabled = this.busy;
        this.button.setAttribute('aria-busy', String(this.busy));
        this.button.title = t(this.busy ? 'agent.layout.openingChat' : 'agent.layout.startChat');
        this.button.setAttribute('aria-label', this.button.title);
        this.label.textContent = t(this.mobile ? 'agent.layout.chat' : this.busy ? 'agent.layout.openingChat' : 'agent.layout.startChat');
    }

    private async open(): Promise<void> {
        if (this.busy || this.disposed || this.options.signal?.aborted || !this.options.onStartConversation) return;
        this.busy = true; this.status.hidden = true; this.update();
        const revision = this.revision, operationId = randomUUID(), started = performance.now();
        let stage = 'save';
        this.log(operationId, stage, 'start', started);
        try {
            await this.flush();
            if (this.disposed || revision !== this.revision || this.options.signal?.aborted) {
                this.log(operationId, stage, 'cancelled', started); return;
            }
            this.log(operationId, stage, 'success', started); stage = 'open';
            await this.options.onStartConversation();
            this.log(operationId, stage, 'success', started);
        } catch (error) {
            this.failed(error, operationId, stage, started);
        } finally {
            this.busy = false; if (!this.disposed) this.update();
        }
    }

    private failed(error: unknown, operationId: string, stage: string, started: number): void {
        const saveStatus = this.root.querySelector<HTMLElement>('[data-autosave-status][data-state="failed"], [data-autosave-status][data-state="invalid"]');
        const code = stage === 'open' ? 'AGENT_CHAT_OPEN_FAILED' : saveStatus?.dataset.state === 'invalid'
            ? 'AGENT_CHAT_VALIDATION_FAILED' : 'AGENT_CHAT_SAVE_FAILED';
        this.log(operationId, stage, 'failure', started, code);
        if (this.disposed) return;
        this.status.textContent = (stage === 'save' ? saveStatus?.textContent : undefined)
            || (error instanceof Error ? error.message : String(error));
        this.status.hidden = false;
    }

    private log(operationId: string, stage: string, result: string, started: number, code?: string): void {
        const metadata = {operation: 'agent.chat.open', operationId, stage, result, code,
            durationMs: Math.round(performance.now() - started)};
        if (result === 'failure') log.error('agent.chat.open', metadata);
        else log.info('agent.chat.open', metadata);
    }

    cancel(): void {this.revision++;}
    destroy(): void {this.disposed = true; this.cancel(); this.button.onclick = null; this.button.remove();}
}
