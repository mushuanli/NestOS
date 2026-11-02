import type {KanbanActor, KanbanBoard, KanbanCommand} from '@itookit/kanban/contracts';
import {sameAutomationBinding} from '@itookit/kanban/contracts';
import type {RootTargetCatalog} from '@itookit/llm-session/contracts';
import {automationTarget, assertAutomationPrincipals} from './automation-targets';
import {requireValue} from './validation';

export async function authorizeAutomation(input: {actor: KanbanActor; board: KanbanBoard; command?: KanbanCommand; action: string},
    catalog: (() => Promise<RootTargetCatalog>) | undefined): Promise<void> {
    const {actor, board, command, action} = input;
    if (actor.kind === 'service') {
        const automation = board.automation;
        requireValue(automation && [automation.coordinator, automation.worker].some(principal => principal.kind === 'service' && principal.id === actor.id), 'FORBIDDEN');
        const allowed = actor.id === automation.coordinator.id
            ? ['read', 'publish-plan', 'observe-execution', 'link-reference', 'close-plan'] : ['read', 'prepare-dispatch', 'renew', 'message', 'block-item', 'unblock-item'];
        requireValue(allowed.includes(action), 'FORBIDDEN');
        if(command?.type==='close-plan')requireValue(board.items.find(item=>item.id===command.itemId)?.planning?.execution==='children','FORBIDDEN');
        if (['publish-plan', 'prepare-dispatch'].includes(action)) requireValue(automation.enabled, 'AUTOMATION_PAUSED');
    }
    if (command?.type !== 'configure-automation') return;
    requireValue(actor.kind === 'human' && catalog, 'AUTOMATION_UNAVAILABLE');
    assertAutomationPrincipals(command.settings);
    if (!command.settings.enabled && board.automation && sameAutomationBinding(board.automation, command.settings)) return;
    const targets = await catalog();
    automationTarget(command.settings.planner, targets); automationTarget(command.settings.executor, targets);
}
