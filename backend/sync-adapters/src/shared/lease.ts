import { assertSync, decimal, type CoordinationGuard } from '@itookit/vfs-sync';
export const LEASE_PATH = '/var/lib/sync/coordination.seq';
export interface Lease { owner: string; fence: string; expiresAt: number }
export function decodeLease(value?: unknown): Lease | undefined {
    if (value === undefined) return undefined;
    const lease = JSON.parse(value as string) as Lease;
    assertSync(lease && typeof lease.owner === 'string' && lease.owner.length > 0
        && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= 0, 'SYNC_CONTROL_CORRUPT');
    assertSync(decimal(lease.fence) > 0n, 'SYNC_CONTROL_CORRUPT'); return lease;
}

export interface LeaseRecords { read(field: string): Promise<Lease | undefined>; write(field: string, lease: Lease): Promise<void> }
export interface LeaseAccess {
    transaction<T>(action: (records: LeaseRecords) => Promise<T>): Promise<T>;
    guard(field: string, lease: Lease, now: () => number): CoordinationGuard;
}
export function assertLease(current: Lease | undefined, expected: Lease, now: number): void {
    assertSync(current?.owner === expected.owner && current.fence === expected.fence
        && current.expiresAt > now, 'SYNC_COORDINATION_LOST');
}
