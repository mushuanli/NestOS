import type { Decision, DurableTaskProgram, TaskInputEvent, TaskProgramManifest } from '../domain/types';
import { assertDurableValue } from '../application/durability';

export type TaskStepEvent<I> = TaskInputEvent | { type: 'initialize'; input: I };

/** One pure step function; execution and recovery still use the existing kernel. */
export function defineTask<S, I = unknown, O = unknown>(spec: TaskProgramManifest & {
    state: S;
    step(state: Readonly<S>, event: TaskStepEvent<I>): Decision<S, O>;
}): DurableTaskProgram<S, I, O> {
    assertDurableValue(spec.state, 'Initial Task state');
    const initialState = structuredClone(spec.state), step = spec.step;
    return {
        manifest: { kind: spec.kind, version: spec.version },
        init: input => step(structuredClone(initialState), { type: 'initialize', input }),
        reduce: (state, event) => step(state, event),
    };
}
