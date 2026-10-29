import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {SeqTwinStore} from '../src/digital-twin/seq-twin-store';
import {TwinRecords} from '../src/digital-twin/records';
import {authorizeScannerExchange} from '../src/digital-twin/scanner-authority';
import {assertScannerPlan} from '../src/digital-twin/scanner-executor';
import {scannerExecutor} from '@itookit/app-contracts';
import {assertCollectionPlan} from '../src/digital-twin/scanner-collector';
it('preauthorizes a provider attempt once and refuses later attempts outside the reserved envelope', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const records = new TwinRecords(await SeqTwinStore.open(await manager.openFileSystem('/'), 'test', 'owner'));
        const job = {sessionId: 'twin-analysis-job', reservedTokens: 2000} as any;
        const request = {request: {messages: [{role: 'user', content: 'short'}], maxTokens: 10}} as any;
        await authorizeScannerExchange(records, job, request, {attemptId: 'attempt-a'} as any);
        const first = await records.get<any>('checkpoint', 'scanner-envelope:' + job.sessionId);
        await authorizeScannerExchange(records, job, request, {attemptId: 'attempt-a'} as any);
        expect((await records.get<any>('checkpoint', 'scanner-envelope:' + job.sessionId))!.data).toEqual(first!.data);
        await expect(authorizeScannerExchange(records, job, request, {attemptId: 'attempt-b'} as any)).rejects.toThrow('TWIN_SCAN_BUDGET_EXHAUSTED');
        expect((await records.get<any>('checkpoint', 'scanner-envelope:' + job.sessionId))!.data.attempts).toEqual(['attempt-a']);
    } finally {await manager.dispose();}
});
it('caps each custom scanner response before reserving its provider attempt', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const records = new TwinRecords(await SeqTwinStore.open(await manager.openFileSystem('/'), 'test', 'owner'));
        const job = {sessionId: 'twin-analysis-output', reservedTokens: 2000, maxOutputTokens: 256} as any;
        const request = {request: {messages: [], maxTokens: 8192}} as any;
        await authorizeScannerExchange(records, job, request, {attemptId: 'attempt'} as any);
        expect(request.request.maxTokens).toBe(256);
        const lower = {request: {messages: [], maxTokens: 128}} as any;
        await authorizeScannerExchange(records, job, lower, {attemptId: 'attempt'} as any);
        expect(lower.request.maxTokens).toBe(128);
    } finally {await manager.dispose();}
});
it('allows static collection tools and rejects model nodes or nested calls before execution', () => {
    const plan = (plugin: string) => ({program: {kind: 'flow.aggregate'}, input: {initialScheduler: {spec: {nodes: [{plugin}]}}}});
    expect(() => assertCollectionPlan(plan('builtin.tool'))).not.toThrow();
    expect(() => assertCollectionPlan(plan('builtin.agent'))).toThrow('TWIN_COLLECTION_STATIC_TOOLS_REQUIRED');
    expect(() => assertCollectionPlan(plan('builtin.spawn'))).toThrow('TWIN_COLLECTION_STATIC_TOOLS_REQUIRED');
    expect(() => assertCollectionPlan({program: {kind: 'llm.chat'}})).toThrow('TWIN_COLLECTION_STATIC_TOOLS_REQUIRED');
});
it('rejects unsafe output paths and unsupported execution before dispatch', () => {
    const target = {kind: 'flow' as const, id: 'reader', version: '1', digest: 'digest'};
    expect(() => assertScannerPlan({program: {kind: 'llm.agent'}, input: {messages: [{content: {kind: 'harness', subtasks: 'business data'}}]}})).not.toThrow();
    const graph = (plugin: string, config: unknown) => ({program: {kind: 'flow.aggregate'}, input: {initialScheduler: {spec: {nodes: [{plugin, config}]}}}});
    expect(() => assertScannerPlan(graph('builtin.agent', {execution: {kind: 'harness'}}))).toThrow('TWIN_SCANNER_EXECUTION_UNSUPPORTED');
    expect(() => assertScannerPlan(graph('builtin.transform', {value: {kind: 'harness', subtasks: []}}))).not.toThrow();
    expect(() => scannerExecutor({target, outputPath: ['__proto__']})).toThrow('TWIN_SCANNER_OUTPUT_INVALID');
    expect(() => assertScannerPlan({program: {kind: 'kernel-adapters.harness'}})).toThrow('TWIN_SCANNER_EXECUTION_UNSUPPORTED');
    expect(() => assertScannerPlan({program: {kind: 'flow.aggregate'}, input: {initialScheduler: {spec: {nodes: [{plugin: 'builtin.spawn'}]}}}})).toThrow('TWIN_SCANNER_EXECUTION_UNSUPPORTED');
});
