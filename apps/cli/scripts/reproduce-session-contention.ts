import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createApplicationRuntime} from '@itookit/app-core';
import {openApplicationView} from '@itookit/app-core/host';
import {openLocalFSBackend, type LocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';
import type {IFileSystem} from '@itookit/vfs-core';
import {RoundLog} from '@itookit/llm-session';
import {SessionProfileRecorder} from './session-profile-recorder';

const {values} = parseArgs({options: {sessions: {type: 'string', default: '24'}, rounds: {type: 'string', default: '40'}, samples: {type: 'string', default: '3'}, out: {type: 'string'}}});
type View = Awaited<ReturnType<typeof openApplicationView>>;
interface Result {scenario: string; sample: number; bindMs: number; totalMs: number; storage: Record<string, number>}

async function fixture(directory: string, recorder: SessionProfileRecorder, count: number, rounds: number) {
    const backend = await openLocalFSBackend({rootDir: path.join(directory, 'data'), sidecarDir: path.join(directory, 'meta'),
        durability: 'full', createDb: async file => recorder.database(await NodeSqliteSidecarDb.open(file))});
    const records = recorder.records(backend.records);
    const profiled = new Proxy(backend, {get(target, key) {
        const method = Reflect.get(target, key, target);
        return key === 'records' ? records : typeof method === 'function' ? method.bind(target) : method;
    }});
    const runtime = await createApplicationRuntime({backend: profiled, ownerKind: 'cli', startupMode: 'headless', digitalTwinAutoStart: false});
    try {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
            const id = await runtime.sessionRepository.createSession(`Fixture ${i}`);
            if (i < 2) await seedHistory(runtime.sessionRepository, id, rounds);
            await runtime.sessionManager.bindSession(id); ids.push(id);
        }
        const fs = await runtime.vfs.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/profile', name: 'background.seq', type: 'seqfile', recursive: true});
        return {backend, runtime, ids, fs};
    } catch (error) {await runtime.dispose(); throw error;}
}

async function seedHistory(repository: ConstructorParameters<typeof RoundLog>[0], id: string, count: number): Promise<void> {
    const log = new RoundLog(repository, id); let parent: string | undefined;
    for (let i = 0; i < count; i++) parent = await log.append('main', {id: `round-${i}`, sessionId: id,
        historyParentIds: parent ? [parent] : [], input: [{role: 'user', content: 'Synthetic prompt '.repeat(64)}],
        output: [{role: 'assistant', content: 'Synthetic response '.repeat(128)}], executions: [], status: 'completed', createdAt: i + 1, origin: 'user'});
}

async function bind(view: View, id: string, recorder: SessionProfileRecorder): Promise<void> {
    const opened = await recorder.measure('api.openSessionView', () => view.backend.openSessionView(id));
    try {
        await recorder.measure('api.activate', () => opened.activate('main'));
        await recorder.measure('api.input-and-tasks', () => Promise.all([
            view.services.commandBus.execute('session.targets.list'), view.services.kernel.kernel.listSessionTasks(id),
        ]));
    } finally {await opened.dispose();}
}

async function background(fs: IFileSystem, recorder: SessionProfileRecorder): Promise<void> {
    const seq = fs.meta.seq!;
    for (let i = 0; i < 40; i++) await recorder.measure('background.transaction', () => seq.transaction!(async tx => {
        await tx.setEntry('/var/lib/profile/background.seq', `entry-${i}`, JSON.stringify({sequence: i, value: 'fixture'.repeat(100)}));
        await tx.getEntry('/var/lib/profile/background.seq', `entry-${i}`);
    }));
}

async function runScenario(name: string, sample: number, view: View, id: string, backend: LocalFSBackend,
    fs: IFileSystem, recorder: SessionProfileRecorder): Promise<Result> {
    const before = backend.sidecarStats, start = performance.now(); let bindMs = 0;
    await recorder.scenario(name, async () => {
        const work: Promise<unknown>[] = [];
        if (name === 'overview') work.push(recorder.measure('api.assistantOverview', () => view.backend.assistantOverview!()));
        if (name === 'storage') work.push(background(fs, recorder));
        const binding = recorder.measure('api.switch', async () => {const at = performance.now(); await bind(view, id, recorder); bindMs = performance.now() - at;});
        const results = await Promise.allSettled([...work, binding]);
        const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    });
    const storage = Object.fromEntries(Object.entries(backend.sidecarStats).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
    return {scenario: name, sample, bindMs: Math.round(bindMs), totalMs: Math.round(performance.now() - start), storage};
}

async function main(): Promise<void> {
    const count = Number(values.sessions), samples = Number(values.samples), rounds = Number(values.rounds);
    if (!Number.isInteger(count) || count < 2 || count > 200 || !Number.isInteger(samples) || samples < 1 || samples > 20 || !Number.isInteger(rounds) || rounds < 0 || rounds > 500)
        throw new Error('Expected --sessions 2..200 --samples 1..20 --rounds 0..500 [--out directory]');
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-session-contention-'));
    const out = values.out ? path.resolve(values.out) : directory; await mkdir(out, {recursive: true});
    const recorder = new SessionProfileRecorder(), f = await fixture(directory, recorder, count, rounds);
    let view: View | undefined;
    try {
        view = await openApplicationView(f.runtime); const results: Result[] = [];
        for (const id of f.ids.slice(0, 2)) await bind(view, id, recorder);
        await recorder.start();
        try {
            for (let sample = 1; sample <= samples; sample++) for (const name of ['alone', 'overview', 'storage']) {
                const result = await runScenario(name, sample, view, f.ids[sample % 2], f.backend, f.fs, recorder);
                results.push(result); process.stdout.write(JSON.stringify(result) + '\n');
            }
        } finally {await recorder.stop(out);}
        await writeFile(path.join(out, 'results.json'), JSON.stringify({sessions: count, rounds, samples, results}, null, 2));
        process.stdout.write(JSON.stringify({artifacts: out, fixture: directory}) + '\n');
    } finally {try {await view?.close();} finally {await f.runtime.dispose();}}
}

void main().catch(error => {console.error(error instanceof Error ? error.message : 'Fixture failed'); process.exitCode = 1;});
