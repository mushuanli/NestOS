import { t } from '@itookit/common';
import { DEFAULT_AGENT_MAX_EXCHANGES, type ChatExecutionMode } from '@itookit/llm-tasks/contracts';

export interface ExecutionModeViewState {
    mode?: ChatExecutionMode;
    flow: boolean;
    loading: boolean;
    locked?: boolean;
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

    constructor(container: HTMLElement, onChange: (mode: ChatExecutionMode) => void, private readonly maxExchanges = DEFAULT_AGENT_MAX_EXCHANGES) {
        this.group = container.querySelector('.llm-input__execution-mode')!;
        this.hint = container.querySelector('.llm-input__execution-hint')!;
        this.buttons = Array.from(this.group.querySelectorAll('button'));
        this.group.addEventListener('click', event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-execution-mode]');
            if (!button || button.disabled || !this.group.contains(button)) return;
            const mode = button.dataset.executionMode;
            if ((mode !== 'chat' && mode !== 'agent') || mode === this.mode) return;
            this.mode = mode;
            this.render();
            onChange(mode);
        });
    }

    update({ mode, flow, loading, locked = false }: ExecutionModeViewState): void {
        this.mode = mode === 'agent' ? 'agent' : 'chat';
        this.flow = flow;
        this.loading = loading;
        this.locked = locked;
        this.render();
    }

    private render(): void {
        for (const button of this.buttons) {
            button.disabled = this.loading || this.flow || this.locked;
            button.title = this.locked ? t('chatInput.executionMode.locked') : '';
            button.setAttribute('aria-pressed', String(!this.flow && button.dataset.executionMode === this.mode));
        }
        this.hint.textContent = this.flow ? t('chatInput.executionMode.flowHint')
            : this.mode === 'agent' ? t('chatInput.executionMode.agentHint', { count: this.maxExchanges })
                : t('chatInput.executionMode.chatHint');
    }
}
