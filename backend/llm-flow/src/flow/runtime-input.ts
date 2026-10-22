import type { FlowRuntimeInput } from '../contracts';

/** Freeze the run envelope independently from authored parameters and mutable variables. */
export function prepareFlowRuntimeInput(value: unknown): FlowRuntimeInput {
    if (value === undefined) return Object.freeze({ prompt: '' });
    if (!isFlowRuntimeInput(value)) throw new TypeError('Invalid Flow runtime input: prompt must be a string');
    return Object.freeze({ prompt: value.prompt });
}

/** Persisted input is deliberately small and contains no executable template metadata. */
export function isFlowRuntimeInput(value: unknown): value is FlowRuntimeInput {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).every(key => key === 'prompt') && Object.hasOwn(value, 'prompt')
        && typeof (value as FlowRuntimeInput).prompt === 'string';
}
