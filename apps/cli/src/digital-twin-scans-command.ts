import { TWIN_KINDS, type DigitalTwinService, type TwinScanPlanInput, type TwinScanRuleInput, type TwinScanRules } from '@itookit/app-core';

export async function scanCommand(service: DigitalTwinService, args: string[], value?: string): Promise<unknown> {
    const [action, id, revision] = args;
    if (action === 'scan-plans' || action === 'scan-runs') return (await service.snapshot()).scans;
    if (action === 'rule-preview') return service.previewScanRule(ruleInput(value));
    if (action === 'rule-create') return service.saveScanRule(null, null, ruleInput(value));
    if (action === 'rule-update') return service.saveScanRule(required(id), required(revision), ruleInput(value));
    if (action === 'plan-create') return service.saveScanPlan(null, null, planInput(value));
    if (action === 'plan-update') return service.saveScanPlan(required(id), required(revision), planInput(value));
    if (action === 'plan-pause' || action === 'plan-enable') return service.setScanPlanEnabled(required(id), required(revision), action === 'plan-enable');
    if (action === 'plan-delete') return service.removeScanPlan(required(id), required(revision));
    if (action === 'scan-cancel') return service.cancelScanRun(required(id));
    if (action === 'scan-tick') { await service.scanOnce(); return (await service.snapshot()).scans; }
    if (action === 'plan-run') {
        const runId = await service.runScanPlan(required(id));
        await service.waitScanRun(runId);
        return (await service.snapshot()).scans.runs.find(run => run.id === runId);
    }
    if (action === 'watch') return watch(service);
    throw new Error('Unknown twin scan command');
}
export const SCAN_COMMANDS = ['rule-create', 'rule-update', 'rule-preview', 'scan-plans', 'scan-runs', 'plan-create', 'plan-update', 'plan-pause', 'plan-enable', 'plan-delete', 'plan-run', 'scan-cancel', 'scan-tick', 'watch'];
function ruleInput(value?: string): TwinScanRuleInput & TwinScanRules {
    const data: unknown = JSON.parse(required(value));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a scan rule JSON object');
    return { name: '', include: [], exclude: [], intervalMinutes: 30, enabled: true, ...data } as TwinScanRuleInput;
}
function planInput(value?: string): TwinScanPlanInput {
    const data: unknown = JSON.parse(required(value));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a scan plan JSON object');
    return { kinds: [...TWIN_KINDS], mode: 'analyze', trigger: 'manual', intervalMinutes: 60,
        tokenLimit: 20000, enabled: true, ...data } as TwinScanPlanInput;
}
function required(value?: string): string { if (!value?.trim()) throw new Error('Missing scan plan ID, revision or --value JSON'); return value; }
async function watch(service: DigitalTwinService): Promise<void> {
    await new Promise<void>(resolve => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        service.start();
        process.stdout.write(JSON.stringify({ status: 'watching', host: 'cli', pollSeconds: 15 }) + '\n');
    });
}
