import { t } from '@itookit/common';
import { DEFAULT_AGENT_MAX_EXCHANGES, type ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export interface ExecutionModeViewState {
    mode?: ChatExecutionMode;
    flow: boolean;
    loading: boolean;
    locked?: boolean;
    remote?: boolean;
}

/** UI preferences affect future sends; the host owns execution and authorization. */
export class ExecutionModeControl {
    private readonly group: HTMLElement;
    private readonly hint: HTMLElement;
    private readonly buttons: HTMLButtonElement[];
    private mode: ChatExecutionMode = 'chat';
    private flow = false;
    private loading = false;
    private locked = false;
    private remote = false;
    private readonly info = document.createElement('div');
    private readonly value = document.createElement('span');
    private readonly explanation = document.createElement('small');

    constructor(container: HTMLElement, onChange: (mode: ChatExecutionMode) => void,
        private maxExchanges = DEFAULT_AGENT_MAX_EXCHANGES, infoContainer?: HTMLElement) {
        this.group = container.querySelector('.llm-input__execution-mode')!;
        this.hint = container.querySelector('.llm-input__execution-hint')!;
        this.buttons = Array.from(this.group.querySelectorAll('button'));
        this.info.className = 'llm-input__execution-info'; this.info.hidden = true;
        const label = document.createElement('strong'); label.textContent = t('chatInput.executionMode.label');
        this.info.append(label, this.value, this.explanation);
        (infoContainer ?? container.querySelector('.llm-input__options-body'))?.append(this.info);
        this.group.addEventListener('click', event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-execution-mode]');
            if (!button || button.disabled || !this.group.contains(button)) return;
            const mode = button.dataset.executionMode;
            if ((mode !== 'chat' && mode !== 'agent') || mode === this.mode) return;
            this.mode = mode;
            this.render();
            this.group.closest<HTMLDetailsElement>('details')!.open = false;
            this.group.closest('details')!.querySelector('summary')!.focus();
            onChange(mode);
        });
    }

    update({ mode, flow, loading, locked = false, remote = false }: ExecutionModeViewState): void {
        this.mode = mode === 'agent' ? 'agent' : 'chat';
        this.flow = flow;
        this.loading = loading;
        this.locked = locked;
        this.remote = remote;
        this.render();
    }

    private render(): void {
        const picker = this.group.closest('details')!;
        picker.hidden = this.remote || this.locked || this.flow;
        if (picker.hidden) picker.open = false;
        picker.querySelector('.llm-input__execution-label')!.textContent = this.flow ? t('chatSettings.flow')
            : t(this.mode === 'agent' ? 'chatInput.executionMode.agent' : 'chatInput.executionMode.chat');
        picker.querySelector('summary')!.title = this.locked ? t('chatInput.executionMode.locked') : t('chatInput.executionMode.label');
        for (const button of this.buttons) {
            button.disabled = this.loading || this.flow || this.locked;
            button.title = this.locked ? t('chatInput.executionMode.locked') : '';
            button.setAttribute('aria-pressed', String(!this.flow && button.dataset.executionMode === this.mode));
        }
        this.hint.textContent = this.flow ? t('chatInput.executionMode.flowHint')
            : this.mode === 'agent' ? t('chatInput.executionMode.agentHint', { count: this.maxExchanges })
                : t('chatInput.executionMode.chatHint');
        this.info.hidden = this.remote || !(this.locked || this.flow);
        this.value.textContent = this.flow ? t('chatSettings.flow')
            : t(this.mode === 'agent' ? 'chatInput.executionMode.agent' : 'chatInput.executionMode.chat');
        this.explanation.textContent = this.flow ? t('chatInput.executionMode.flowHint') : t('chatInput.executionMode.locked');
    }
    configure(container?: HTMLElement, maxExchanges = DEFAULT_AGENT_MAX_EXCHANGES): void {
        this.maxExchanges = maxExchanges; if (container) container.append(this.info); this.render();
    }
    destroy(): void { this.info.remove(); }
}
