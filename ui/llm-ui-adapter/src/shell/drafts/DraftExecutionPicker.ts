import { t } from '@itookit/common';
import type { ChatInput } from '../../components/input/ChatInputView';
import type { ExecutorOption } from '../../domain/types';

type Target = 'chat' | 'harness';
const targetOf = (id: string): Target => id.startsWith('remote:') ? 'harness' : 'chat';

/** Execution targets filter assistant choices without creating a Session or changing credentials. */
export class DraftExecutionPicker {
    private readonly element = document.createElement('div');
    private readonly hint = document.createElement('p');
    private readonly remembered = new Map<Target, string>();
    private target: Target;
    private loading = false;
    constructor(parent: HTMLElement, private readonly input: ChatInput, private readonly agents: ExecutorOption[],
        private readonly openFlows?: () => void) {
        this.target = targetOf(input.getConfig().agentId);
        this.element.className = 'llm-draft-target'; this.element.setAttribute('role', 'group');
        this.element.setAttribute('aria-label', t('chatInput.target.label'));
        for (const target of ['chat', 'harness', 'flow'] as const) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.executionTarget = target;
            button.textContent = t(`chatInput.target.${target}`);
            button.onclick = () => target === 'flow' ? this.openFlows?.() : this.select(target);
            this.element.append(button);
        }
        this.hint.className = 'llm-draft-target__hint'; this.hint.setAttribute('role', 'status');
        this.element.append(this.hint); parent.prepend(this.element);
        const available = this.choices(this.target);
        if (available.length) input.setExecutorChoices(available, input.getConfig().agentId);
        this.update();
    }
    setLoading(loading: boolean): void { this.loading = loading; this.update(); }
    destroy(): void { this.element.remove(); }
    private choices(target: Target): ExecutorOption[] { return this.agents.filter(agent => targetOf(agent.id) === target); }
    private select(target: Target): void {
        if (this.loading || !this.choices(target).length) return;
        this.remembered.set(this.target, this.input.getConfig().agentId); this.target = target;
        const choices = this.choices(target), previous = this.remembered.get(target);
        this.input.setExecutorChoices(choices, choices.find(agent => agent.id === previous)?.id ?? choices[0].id);
        this.update();
    }
    private update(): void {
        for (const button of this.element.querySelectorAll<HTMLButtonElement>('button')) {
            const target = button.dataset.executionTarget as Target | 'flow';
            const absent = target === 'flow' ? !this.openFlows : !this.choices(target as Target).length;
            button.disabled = this.loading || absent;
            if (target !== 'flow') button.setAttribute('aria-pressed', String(target === this.target));
            button.title = t(target === 'harness' && absent ? 'chatInput.target.noHarness' : `chatInput.target.${target}Hint`);
        }
        this.hint.textContent = t(`chatInput.target.${this.target}Hint`);
    }
}
