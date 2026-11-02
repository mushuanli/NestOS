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
    private readonly toggle: HTMLInputElement;
    private readonly change: () => void;
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
        this.group = container.querySelector('.llm-input__tool-execution-setting')!;
        this.hint = container.querySelector('.llm-input__execution-hint')!;
        this.toggle = this.group.querySelector('input')!;
        this.info.className = 'llm-input__execution-info'; this.info.hidden = true;
        const label = document.createElement('strong'); label.textContent = t('chatInput.executionMode.label');
        this.info.append(label, this.value, this.explanation);
        (infoContainer ?? container.querySelector('.llm-input__options-body'))?.append(this.info);
        this.change = () => {
            if (this.loading || this.flow || this.locked || this.remote) {this.render(); return;}
            this.mode = this.toggle.checked ? 'agent' : 'chat'; this.render(); onChange(this.mode);
        };
        this.toggle.addEventListener('change', this.change);
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
        this.group.hidden = this.remote || this.flow;
        this.toggle.checked = this.mode === 'agent';
        this.toggle.disabled = this.loading || this.flow || this.locked || this.remote;
        this.toggle.title = this.locked ? t('chatInput.executionMode.locked') : '';
        this.hint.textContent = this.locked ? t('chatInput.executionMode.locked') : this.flow ? t('chatInput.executionMode.flowHint')
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
    destroy(): void { this.toggle.removeEventListener('change', this.change); this.info.remove(); }
}
