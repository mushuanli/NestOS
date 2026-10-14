// @file: durable-kernel/src/domain/errors.ts
// Kernel 统一错误契约：可机器判别的错误码，供上层按 code 分支处理。

export enum KernelErrorCode {
    SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
    TASK_NOT_FOUND = 'TASK_NOT_FOUND',
    BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
    BUDGET_INVALID = 'BUDGET_INVALID',
    STALE_SHARED_LEASE = 'STALE_SHARED_LEASE',
    STALE_EFFECT_CLAIM = 'STALE_EFFECT_CLAIM',
    HANDLE_LACKS_RIGHT = 'HANDLE_LACKS_RIGHT',
    HANDLE_REVOKED = 'HANDLE_REVOKED',
    EFFECT_TIMEOUT = 'EFFECT_TIMEOUT',
    EFFECT_CANCELLED = 'EFFECT_CANCELLED',
    INVALID_SPEC = 'INVALID_SPEC',
    CONFLICT = 'CONFLICT',
}

export class KernelError extends Error {
    readonly code: KernelErrorCode;

    constructor(code: KernelErrorCode, message: string) {
        super(message);
        this.name = 'KernelError';
        this.code = code;
    }
}

export function kernelError(code: KernelErrorCode, message: string): KernelError {
    return new KernelError(code, message);
}
