import type {PreparedActivation} from './upgrade-group';
interface PlanOptions {
    needsSync: boolean; check(): void; block(): void; resume(): void;
    connections: {commit(): void; rollback(): void};
    catalog?: {check(): void; commit(): void; rollback(): void};
    publish(): () => void;
    rollbackSettings(): Promise<void>;
}

/** All asynchronous preparation precedes this synchronous publication barrier. */
export function activationPlan(options: PlanOptions): PreparedActivation {
    let revert: (() => void) | undefined;
    return {needsSync: options.needsSync,
        check: () => {options.check(); options.catalog?.check();},
        commit: () => {
            options.check(); options.connections.commit();
            revert = options.publish(); options.catalog?.commit();
        },
        rollback: async () => {
            options.connections.rollback(); options.catalog?.rollback(); revert?.(); revert = undefined;
            await options.rollbackSettings();
        }, block: options.block, resume: options.resume};
}
