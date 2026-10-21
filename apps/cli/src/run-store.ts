import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventEnvelope } from '@itookit/durable-kernel';
import { extractNodeOutput } from '@itookit/llm-tasks';
import type { RunManifest, WorkspaceGrant } from './types';

export class RunStore {
    constructor(readonly stateDir: string) {}

    runDir(runId: string): string {
        return path.join(this.stateDir, 'runs', runId);
    }

    async create(manifest: RunManifest, configSource: string): Promise<void> {
        const dir = this.runDir(manifest.id);
        await mkdir(path.join(dir, 'artifacts'), { recursive: true });
        await writeFile(path.join(dir, 'config.snapshot.yml'), configSource, { encoding: 'utf8', flag: 'wx' });
        await this.save(manifest);
    }

    async load(runId: string): Promise<RunManifest> {
        const content = await readFile(path.join(this.runDir(runId), 'run.json'), 'utf8');
        return JSON.parse(content) as RunManifest;
    }

    async save(manifest: RunManifest): Promise<void> {
        manifest.updatedAt = Date.now();
        const target = path.join(this.runDir(manifest.id), 'run.json');
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8');
        await rename(temporary, target);
    }

    async appendEvent(runId: string, event: EventEnvelope): Promise<void> {
        const target = path.join(this.runDir(runId), 'events.jsonl');
        await appendFile(target, `${JSON.stringify(redact(event))}\n`, 'utf8');
    }

    async list(): Promise<RunManifest[]> {
        const root = path.join(this.stateDir, 'runs');
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        const manifests = await Promise.all(entries.filter(item => item.isDirectory()).map(item =>
            this.load(item.name).catch(() => undefined)));
        return manifests.filter((item): item is RunManifest => Boolean(item))
            .sort((left, right) => right.createdAt - left.createdAt);
    }

    async writeArtifacts(runId: string, output: unknown): Promise<void> {
        const nodes = record(record(output).nodes);
        for (const [nodeId, nodeOutput] of Object.entries(nodes)) {
            const target = path.join(this.runDir(runId), 'artifacts', safeSegment(nodeId), 'result.json');
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, JSON.stringify(redact(nodeOutput), null, 2), 'utf8');
        }
    }

    async writeResult(runId: string, value: unknown): Promise<string> {
        const extension = typeof value === 'string' ? 'txt' : 'json';
        const relative = `result.${extension}`;
        const target = path.join(this.runDir(runId), relative);
        await writeFile(target, typeof value === 'string' ? redactText(value) : JSON.stringify(redact(value), null, 2), 'utf8');
        return relative;
    }

    async updateGrants(runId: string, grants: WorkspaceGrant[]): Promise<void> {
        const manifest = await this.load(runId);
        manifest.grants = grants;
        await this.save(manifest);
    }

    configSnapshot(runId: string): string {
        return path.join(this.runDir(runId), 'config.snapshot.yml');
    }

    eventsPath(runId: string): string {
        return path.join(this.runDir(runId), 'events.jsonl');
    }

    async delete(runId: string): Promise<void> {
        await rm(this.runDir(runId), { recursive: true, force: true });
    }
}

export function selectFinalResult(output: unknown, taskId: string, outputName: string): unknown {
    const node = record(record(output).nodes)[taskId];
    if (node === undefined) return undefined;
    if (outputName === '*') return Object.fromEntries(Object.keys(record(record(node).outputs))
        .map(name => [name, extractNodeOutput(node, name)]));
    return extractNodeOutput(node, outputName);
}

function redact(value: unknown): unknown {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        /(?:api.?key|token|secret|password|credential)/i.test(key) ? '[REDACTED]' : redact(item),
    ]));
}

function redactText(value: string): string {
    let result = value;
    for (const [key, secret] of Object.entries(process.env)) {
        if (!secret || secret.length < 8 || !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
        result = result.split(secret).join('[REDACTED]');
    }
    return result;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
