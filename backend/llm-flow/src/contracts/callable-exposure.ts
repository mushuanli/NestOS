/** Legacy definitions without an explicit exposure remain root-callable. */
export type CallableExposure = 'global' | 'local';

export class CallableExposureError extends Error {
    constructor(readonly code: 'CALLABLE_EXPOSURE_INVALID' | 'CALLABLE_LOCAL_ONLY') {
        super(code === 'CALLABLE_LOCAL_ONLY' ? 'Local definitions can only be called inside a Flow' : 'Exposure must be global or local');
        this.name = 'CallableExposureError';
    }
}

export function callableExposure(value: unknown): CallableExposure {
    if (value === undefined) return 'global';
    if (value === 'global' || value === 'local') return value;
    throw new CallableExposureError('CALLABLE_EXPOSURE_INVALID');
}

/** A read projection may hide malformed definitions, but admission must report the error. */
export function isRootCallable(definition: { exposure?: unknown }): boolean {
    return definition.exposure === undefined || definition.exposure === 'global';
}

export function assertRootCallable(definition: { exposure?: unknown }): void {
    if (callableExposure(definition.exposure) === 'local') throw new CallableExposureError('CALLABLE_LOCAL_ONLY');
}
