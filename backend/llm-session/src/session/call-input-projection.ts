import type {TaskInput} from '../core/types';
import type {Round} from '../contracts/conversation';

/** Project the accepted input without resolving defaults or reading mutable definitions again. */
export function callInputProjection(input: TaskInput): Round['callInput'] {
    return input.source ? {source: structuredClone(input.source),
        ...(input.instructionFlowBinding?.inputResolution ? {admitted: structuredClone(input.instructionFlowBinding.inputResolution)} : {})} : undefined;
}
