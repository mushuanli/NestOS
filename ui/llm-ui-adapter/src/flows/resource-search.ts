import {ResourceCommand, type ResourceScope} from '@itookit/app-contracts';
import {t} from '@itookit/common';
import type {ICommandBus} from '@itookit/llm-session/contracts';

/** Search only on request; suggestions never read file bodies. */
export function mountResourceSearch(input: HTMLInputElement, commands: ICommandBus, scope: ResourceScope, signal: AbortSignal): HTMLElement {
    const box = document.createElement('span'), button = document.createElement('button'), choices = document.createElement('select');
    button.type = 'button'; button.textContent = t('flow.source.search'); choices.hidden = true;
    choices.setAttribute('aria-label', t('flow.source.reference')); box.append(button, choices);
    let generation = 0;
    input.addEventListener('input', () => {generation++; choices.hidden = true;}, {signal});
    choices.onchange = () => {if (!choices.value) return; input.value = choices.value; input.dispatchEvent(new Event('input'));};
    button.onclick = async () => {
        const current = ++generation;
        button.disabled = true;
        try {
            const result = await commands.execute<Array<{label: string; reference: string}>>(ResourceCommand.Search, {query: input.value, scope});
            if (signal.aborted || generation !== current) return;
            choices.replaceChildren(new Option(t('flow.source.selectFile'), ''), ...result.map(item => new Option(item.label, item.reference)));
            choices.hidden = false; input.setCustomValidity('');
        } catch (error) {
            if (!signal.aborted && generation === current) {input.setCustomValidity(error instanceof Error ? error.message : String(error)); input.reportValidity();}
        } finally {button.disabled = false;}
    };
    return box;
}
