import type { SharedLeaseCondition } from '../../domain/types';
import { KernelErrorCode, kernelError } from '../../domain/errors';
import { readSharedTx } from './store-helpers';

/** Validate ownership in the same transaction as the guarded write, on a shared host clock. */
export async function assertSharedLeaseTx(
    tx: Parameters<typeof readSharedTx>[0], root: string, condition?: SharedLeaseCondition,
): Promise<void> {
    if (!condition) return;
    const { key, ownerId, epoch } = condition;
    if (typeof key !== 'string' || !key || typeof ownerId !== 'string' || !ownerId
        || !Number.isSafeInteger(epoch) || epoch < 1) {
        throw kernelError(KernelErrorCode.INVALID_SPEC, 'Invalid shared lease condition');
    }
    const value = (await readSharedTx(tx, root, key))?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.ownerId !== ownerId || value.epoch !== epoch || value.deleted === true
        || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
        || value.expiresAt <= Date.now()) {
        throw kernelError(KernelErrorCode.STALE_SHARED_LEASE, `Shared lease lost: ${key}@${epoch}`);
    }
}
