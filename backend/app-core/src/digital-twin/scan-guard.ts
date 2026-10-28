import { selectedRules } from './selection';
import { matchesLine } from './scan-rules';
import type { TwinSourceData, TwinSettings } from './domain';
import { write } from './records';
import type { TwinScanCharge, TwinScanGuardPort, TwinScanPlan, TwinScanRun } from './scan-domain';
import { TwinScanStore } from './scan-store';

/** Rechecked at reservation, model dispatch and result commit, including recovered tasks. */
export function createScanGuard(store: TwinScanStore): TwinScanGuardPort {
    return async (scope, charge?: TwinScanCharge) => {
        const run = await store.records.get<TwinScanRun>('scan-run', scope.runId);
        if (!run || run.data.state !== 'running' || run.data.owner !== store.owner || run.data.fence !== scope.fence
            || run.data.planId !== scope.planId || run.data.planRevision !== scope.planRevision
            || !run.data.sourceIds.includes(scope.sourceId) || JSON.stringify(run.data.kinds) !== JSON.stringify(scope.kinds)
            || JSON.stringify(run.data.executor) !== JSON.stringify(scope.executor)
            || (run.data.focus ?? '') !== (scope.focus ?? '')) throw new Error('TWIN_SCAN_PERMISSION_DENIED');
        const conditions = [await store.fence(scope.fence), { family: 'scan-run' as const, id: run.id, expectedRevision: run.revision }];
        let budgetUnlimited = run.data.budgetUnlimited === true, tokenLimit = run.data.tokenLimit;
        if (scope.planId) {
            const plan = await store.records.get<TwinScanPlan>('scan-plan', scope.planId);
            if (!plan?.data.enabled || plan.revision !== scope.planRevision) throw new Error('TWIN_SCAN_PLAN_STALE');
            conditions.push({ family: 'scan-plan', id: plan.id, expectedRevision: plan.revision });
            if (plan.data.rules) {
                const source = await store.records.get<TwinSourceData>('source', scope.sourceId);
                const settings = (await store.records.get<TwinSettings>('settings', 'pot'))!;
                budgetUnlimited = settings.data.budgetUnlimited === true; tokenLimit = settings.data.tokenLimit;
                const all = (await store.records.list<TwinScanPlan>('scan-plan')).filter(item => item.data.enabled && item.data.rules).map(item => item.data.rules!);
                if (!source?.data.enabled || !source.data.resource || !selectedRules(source.data.resource, plan.data.rules, all)
                    || (settings.data.globalExclude ?? []).some(line => matchesLine(source.data.resource!, line))
                    || settings.data.connectionId !== run.data.connectionId) throw new Error('TWIN_SCAN_PERMISSION_DENIED');
                conditions.push({ family: 'settings', id: settings.id, expectedRevision: settings.revision });
            }
        }
        if (!charge) return { conditions, writes: [] };
        const reservedTokens = run.data.reservedTokens + (charge.reserve ?? 0) - (charge.settle?.reserved ?? 0);
        const spentTokens = run.data.spentTokens + (charge.settle?.spent ?? 0);
        if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0 || !Number.isSafeInteger(spentTokens) || spentTokens < 0) throw new Error('TWIN_INVALID_BUDGET');
        if (charge.reserve && run.data.runTokenLimit !== undefined && reservedTokens + spentTokens > run.data.runTokenLimit) throw new Error('TWIN_SCAN_BUDGET_EXHAUSTED');
        if (charge.reserve && !budgetUnlimited && reservedTokens + spentTokens > tokenLimit) throw new Error('TWIN_SCAN_BUDGET_EXHAUSTED');
        return { conditions, writes: [write('scan-run', run.id, { ...run.data, budgetUnlimited, tokenLimit, reservedTokens, spentTokens }, run.revision)] };
    };
}
