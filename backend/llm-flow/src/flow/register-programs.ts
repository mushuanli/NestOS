import type { Kernel, DurableTaskProgram } from '@itookit/durable-kernel';
import { ContextTaskProgram, DurableAgentProgram, DurableChatProgram, DurablePlanProgram } from '@itookit/llm-tasks';
import { FlowAggregateProgram, FlowHumanProgram, FlowValueProgram } from './programs';
import { FlowInputProgram } from './structured/input';
import type { FlowReducerRegistry } from './structured/join';
import { FlowDispatchProgram } from './structured/dispatch';
import { FlowJoinProgram } from './control/join-program';

/** Register the Durable programs shared by direct Chat, Agent and Flow execution. */
export function registerDurablePrograms(kernel: Pick<Kernel, 'programs' | 'registerProgram'>, reducers?: FlowReducerRegistry, context = false): void {
    const programs: DurableTaskProgram[] = [
        new DurableChatProgram(),
        new DurableAgentProgram(),
        new DurablePlanProgram(),
        new FlowValueProgram(reducers),
        new FlowHumanProgram(),
        new FlowAggregateProgram(),
        new FlowInputProgram(),
        new FlowDispatchProgram(reducers),
        new FlowJoinProgram(),
    ];
    if (context) programs.push(new ContextTaskProgram(new DurableAgentProgram()), new ContextTaskProgram(new DurableChatProgram()));
    for (const program of programs) {
        if (!kernel.programs.has(program.manifest.kind, program.manifest.version)) {
            kernel.registerProgram(program);
        }
    }
}
