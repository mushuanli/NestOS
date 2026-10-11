import type { DigitalTwinService, TwinMemoryData, TwinSourceSpec } from '@itookit/app-core';
import { createHttpMindOSRuntime } from './http-server';
import type { CommandOptions } from './commands';
import { scanCommand, SCAN_COMMANDS } from './digital-twin-scans-command';

/** Explicit profile administration uses the same service and SQLite SeqFiles as the desktop host. */
export async function digitalTwinCommand(args: string[], options: CommandOptions): Promise<number> {
    const originalLog = console.log;
    console.log = (...values) => console.error(...values);
    let runtime;
    try { runtime = await createHttpMindOSRuntime(options, false); } finally { console.log = originalLog; }
    try {
        const result = await execute(runtime.digitalTwin!, args, options.value);
        process.stdout.write(`${JSON.stringify(result ?? { success: true }, null, 2)}\n`);
        return 0;
    } finally { await runtime.dispose(); }
}
async function execute(service: DigitalTwinService, args: string[], value?: string): Promise<unknown> {
    const [action, id, revision, decision] = args;
    if (SCAN_COMMANDS.includes(action)) return scanCommand(service, args, value);
    if (action === 'list') return service.snapshot();
    if (action === 'add-memory') return service.addMemory(object(value) as Partial<TwinMemoryData>);
    if (action === 'add-source') {
        const data = object(value) as unknown as TwinSourceSpec & { connectionId: string };
        return service.addSource({ kind: data.kind, target: data.target, label: data.label }, required(data.connectionId, 'connectionId'));
    }
    if (action === 'settings') return service.configure(object(value), required(revision ?? id, 'revision'));
    if (action === 'preview-source') return service.previewSource(object(value) as unknown as TwinSourceSpec);
    if (action === 'remove-source') return service.removeSource(required(id, 'source id'), required(revision, 'revision'));
    if (action === 'forget-subject' || action === 'forget-project') return service.forgetScope(action === 'forget-subject'
        ? { subjectId: required(id, 'subject id') } : { project: required(id, 'project identifier') }, value ? stringArray(value) : []);
    if (action === 'link-execution') return service.linkExecution(required(id, 'memory id'), required(revision, 'revision'), object(value) as { sessionId: string; taskId: string });
    if (action === 'analyze') return service.analyze(required(id, 'source id'));
    if (action === 'cancel') return service.cancelAnalysis(required(id, 'job id'));
    if (action === 'revoke-source' || action === 'enable-source') return service.setSourceEnabled(required(id, 'source id'), required(revision, 'revision'), action === 'enable-source');
    if (action === 'forget') return service.forget(required(id, 'memory id'), value ? stringArray(value) : []);
    if (action === 'suppress') return service.suppress(required(id, 'memory id'), required(revision, 'revision'));
    if (action === 'review') {
        if (!['confirm', 'reject', 'dispute', 'correct'].includes(decision)) throw new Error('Expected confirm/reject/dispute/correct');
        return service.review(required(id, 'memory id'), required(revision, 'revision'), decision as 'confirm' | 'reject' | 'dispute' | 'correct', value ? object(value) : undefined);
    }
    throw new Error('twin requires list/add-source/add-memory/analyze/cancel/review/forget/suppress/settings/revoke-source/enable-source');
}
function object(value?: string): Record<string, unknown> {
    const data: unknown = JSON.parse(required(value, '--value JSON'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
    return data as Record<string, unknown>;
}
function stringArray(value: string): string[] {
    const data: unknown = JSON.parse(value);
    if (!Array.isArray(data) || data.some(item => typeof item !== 'string')) throw new Error('Expected Session IDs as a JSON string array');
    return data;
}
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`Missing ${name}`); return value; }
