import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplicationRuntime, type ApplicationRuntime } from '@itookit/app-core';
import { openLocalFSBackend, type ISidecarDb } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from '@itookit/node-host/storage';

/**
 * Boot-cost profile: counts logical sidecar (SQLite) calls and VFS engine operations per boot stage.
 *
 * Run with: `pnpm --filter @itookit/cli exec tsx tests/fixtures/profile-boot-cost.ts`
 *
 * Both counters are logical operations, not transport round trips. On the desktop every engine
 * operation and every sidecar call costs at least one host invocation, so the counts are the part
 * of boot cost that a code change can move; local wall time here is only a sanity check.
 */
type Counts = Map<string, number>;
const bump = (map: Counts, key: string) => map.set(map.has(key) ? key : key, (map.get(key) ?? 0) + 1);
const total = (map: Counts) => [...map.values()].reduce((sum, count) => sum + count, 0);
const listed = (map: Counts) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));

/**
 * Counts every sidecar call *with its arguments* (path / field / key), so redundant reads of the
 * same path are visible. Transaction callbacks receive a wrapped handle as well.
 */
function countingDb(db: ISidecarDb, report: (signature: string) => void): ISidecarDb {
    const proxies = new WeakMap<object, ISidecarDb>();
    const wrap = (target: ISidecarDb): ISidecarDb => {
        const cached = proxies.get(target as object);
        if (cached) return cached;
        const proxy = new Proxy(target, { get(object, property) {
            const value = Reflect.get(object, property, object);
            if (typeof value !== 'function') return value;
            const name = String(property);
            if (name === 'transaction') {
                return (operation: (inner: ISidecarDb) => Promise<unknown>) => {
                    report(`${name}()`);
                    return (value as (callback: (inner: ISidecarDb) => Promise<unknown>) => Promise<unknown>)
                        .call(object, (inner: ISidecarDb) => operation(wrap(inner)));
                };
            }
            return (...args: unknown[]) => {
                report(`${name} ${args.slice(0, 2).map(value => String(value)).join(' :: ').slice(0, 140)}`);
                return (value as (...rest: unknown[]) => unknown).apply(object, args);
            };
        } });
        proxies.set(target as object, proxy);
        return proxy;
    };
    return wrap(db);
}

/** Collapse volatile identities so the same read shows up as one row. */
function normalizeSignature(signature: string): string {
    return signature
        .replace(/node-\d+-[a-z0-9]+/gi, '<session>')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
        .replace(/task_[0-9a-f-]+/gi, '<task>')
        .replace(/\b\d{6,}\b/g, '<n>');
}

const IO_FIELDS = ['stat', 'list', 'read', 'write', 'mkdir', 'delete', 'rename'] as const;
type IoCounts = Record<(typeof IO_FIELDS)[number], number>;

const zeroIo = (): IoCounts => ({ stat: 0, list: 0, read: 0, write: 0, mkdir: 0, delete: 0, rename: 0 });
const readIo = (io: IoCounts): IoCounts => Object.fromEntries(IO_FIELDS.map(field => [field, io[field]])) as IoCounts;
const subtractIo = (current: IoCounts, previous: IoCounts): IoCounts =>
    Object.fromEntries(IO_FIELDS.map(field => [field, current[field] - previous[field]])) as IoCounts;

interface Stage { stage: string; ms: number; sidecar: number; io: IoCounts; top: Record<string, number> }

async function boot(root: string, prepare?: (runtime: ApplicationRuntime) => Promise<void>): Promise<{
    stages: Stage[]; sidecar: Record<string, number>; signatures: Record<string, number>; io: IoCounts; totalMs: number; runtime: ApplicationRuntime;
}> {
    const sidecarCalls: Counts = new Map(), sidecarSignatures: Counts = new Map();
    let runtime: ApplicationRuntime | undefined;
    const backend = await openLocalFSBackend({
        rootDir: root, sidecarDir: path.join(root, '_meta'),
        createDb: async file => countingDb(await NodeSqliteSidecarDb.open(file), signature => {
            bump(sidecarCalls, signature.split(' ')[0]);
            bump(sidecarSignatures, normalizeSignature(signature));
        }),
    });
    const started = performance.now();
    const stages: Stage[] = [];
    let mark = { stage: '启动前', ms: started, sidecar: total(sidecarCalls), io: zeroIo(), signatures: new Map(sidecarSignatures) };
    const record = (stage: string) => {
        const now = performance.now();
        const io = runtime ? readIo(runtime.vfs.ioStats) : zeroIo();
        const top: Record<string, number> = {};
        for (const [signature, count] of sidecarSignatures) {
            const before = mark.signatures.get(signature) ?? 0;
            if (count > before) top[signature] = count - before;
        }
        stages.push({ stage: mark.stage, ms: now - mark.ms, sidecar: total(sidecarCalls) - mark.sidecar,
            io: subtractIo(io, mark.io), top: Object.fromEntries(Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 6)) });
        mark = { stage, ms: now, sidecar: total(sidecarCalls), io, signatures: new Map(sidecarSignatures) };
    };
    runtime = await createApplicationRuntime({ backend, ownerKind: 'cli', onProgress: record });
    record('完全就绪');
    await new Promise(resolve => setTimeout(resolve, 400));
    record('空闲 400ms');
    if (prepare) { await prepare(runtime); record('准备数据'); }
    return { stages, sidecar: listed(sidecarCalls), signatures: Object.fromEntries([...sidecarSignatures].sort((a, b) => b[1] - a[1]).slice(0, 25)), io: readIo(runtime.vfs.ioStats), totalMs: performance.now() - started, runtime };
}

function report(title: string, result: Awaited<ReturnType<typeof boot>>): Record<string, unknown> {
    return {
        scenario: title,
        totalMs: Math.round(result.totalMs),
        totalSidecarCalls: total(new Map(Object.entries(result.sidecar))),
        vfsOperations: Object.fromEntries(IO_FIELDS.map(field => [field, result.io[field]])),
        stages: result.stages.map(stage => ({ ...stage, ms: Math.round(stage.ms) })),
        sidecarByOperation: result.sidecar,
        topSignatures: result.signatures,
    };
}

async function main(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), 'mindos-boot-cost-'));
    const output: unknown[] = [];
    try {
        const first = await boot(root);
        output.push(report('冷启动（空 profile，含默认配置落盘）', first));
        await first.runtime.dispose();

        console.error('### scenario 2');
        const warm = await boot(root);
        output.push(report('暖启动（默认值已在，0 Session）', warm));

        // Bind to the kernel so the next boot lists, leases and recovers these Sessions.
        const sessions: string[] = [];
        for (const name of ['one', 'two', 'three']) {
            const id = await warm.runtime.sessionRepository.createSession(`boot-${name}`);
            await warm.runtime.sessionManager.bindSession(id);
            sessions.push(id);
        }
        await warm.runtime.dispose();

        console.error('### scenario 3');
        const bound = await boot(root);
        output.push(report('暖启动（3 个空 Session，已绑定 kernel）', bound));

        // Terminal Tasks: cancelled while deferred, so recovery has records to scan but no work to run.
        let seeded = 0;
        for (const [index, id] of sessions.entries()) {
            for (let task = 0; task < 3; task++) {
                const handle = await bound.runtime.kernel.kernel.submit(id, {
                    program: { kind: 'llm.chat', version: '2' }, deferStart: true, requestId: `seed-${index}-${task}`,
                    input: { sessionId: id, roundId: `round-${task}`, connectionId: 'default', stream: false,
                        messages: [{ role: 'user', content: 'seed' }] },
                });
                await handle.cancel('seed');
                seeded++;
            }
        }
        await bound.runtime.kernel.kernel.waitIdle();
        console.error('### scenario 4: seeded terminal tasks = ' + seeded);
        await bound.runtime.dispose();

        const withTasks = await boot(root);
        output.push(report('暖启动（3 个 Session + 9 个终态 Task）', withTasks));
        const statuses = (await withTasks.runtime.kernel.kernel.listSessionTasks(sessions[0])).map(task => task.status);
        console.error('### task statuses after boot: ' + JSON.stringify(statuses));
        await withTasks.runtime.dispose();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
    console.log(JSON.stringify(output, null, 2));
}

await main();
