import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { HarnessClient, RemoteProject } from '@itookit/mindos-node-driver';
import type { LLMProvider, LLMConnection } from '@itookit/driver-llm/contracts';

export interface RealMetadata {
    endpoint: string; project: RemoteProject; credentialFile: string; profileId: string;
    root: string; projectDirectory: string; cloudModel: boolean; fixedPeer: boolean; configuredModel?: string;
}
export interface Review {
    nonce: string;
    findings: Array<{ symbol: string; cwe: string; evidence: string }>;
    safeFunctions: string[];
}
export async function realMetadata(path: string): Promise<RealMetadata> {
    const metadata = JSON.parse(await readFile(resolve(path), 'utf8')) as RealMetadata;
    if (metadata.cloudModel !== true || metadata.fixedPeer !== false) throw new Error('Actual model metadata is required');
    return metadata;
}
export async function coordinatorConfiguration(path: string) {
    const source = JSON.parse(await readFile(path, 'utf8')) as { provider: LLMProvider; connection: LLMConnection };
    const modelId = source.connection.tiers.fast ?? source.connection.tiers.standard ?? source.connection.tiers.optimal;
    if (!modelId) throw new Error('A configured real coordinator model is required');
    return { provider: { ...source.provider, id: 'real-coordinator-provider' }, modelId,
        connection: { ...source.connection, id: 'real-coordinator-connection', providerId: 'real-coordinator-provider',
            tiers: { optimal: modelId, standard: modelId, fast: modelId } } };
}
export function reviewInstruction(target: string): string {
    return `Use the Read tool to inspect the project files ${target} and challenge.txt in the current working directory. `
        + 'Review the code statically; do not execute commands, change files, or exploit anything. '
        + 'If another tool is denied, continue using Read for these fixture files; do all arithmetic and reasoning without a shell. '
        + 'Return one compact JSON object with nonce (the entire challenge.txt content trimmed), '
        + 'findings (objects with symbol, cwe in CWE-NNN format, and short evidence), and safeFunctions (function names). '
        + 'Distinguish unsafe user-input interpolation from parameterized SQL or subprocess argument arrays. '
        + 'Report only the vulnerable function as a finding and the safe counterpart under safeFunctions.';
}
export function parseReview(text: string): Review {
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
        try {
            const value = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as Review;
            if (typeof value.nonce === 'string' && Array.isArray(value.findings) && Array.isArray(value.safeFunctions)) return value;
        } catch { /* Native assistant commentary may precede its final JSON object. */ }
    }
    throw new Error('Native review did not contain the required JSON object');
}
export function verifyReview(text: string, nonce: string, kind: 'sql' | 'shell'): Review {
    const review = parseReview(text), symbol = kind === 'sql' ? 'lookup_record' : 'run_job';
    const safe = kind === 'sql' ? 'lookup_bound' : 'run_bound', cweId = kind === 'sql' ? 89 : 78;
    expect(review.nonce).toBe(nonce);
    expect(review.findings).toHaveLength(1); expect(review.findings[0]).toMatchObject({ symbol });
    expect(Number(review.findings[0].cwe.match(/^CWE-(\d+)$/)?.[1])).toBe(cweId);
    expect(review.findings[0].evidence.length).toBeGreaterThan(5); expect(review.safeFunctions).toContain(safe);
    return review;
}
export async function nativeEvidence(client: HarnessClient, profile: string, sessionId: string) {
    const history = await client.read(profile, sessionId), items: Array<Record<string, unknown>> = [];
    for (const value of history.turns ?? []) {
        const turn = value as { items?: Array<Record<string, unknown>> };
        items.push(...(turn.items ?? [value as Record<string, unknown>]));
    }
    const tools = items.filter(item => item.type === 'functionCall').map(item => String(item.name));
    expect(tools).toContain('Read');
    const usage = await client.usage?.(profile, sessionId);
    const models = await client.models?.(profile, sessionId);
    return { toolNames: [...new Set(tools)], usage: usage ?? null, modelSelection: models?.current ?? null };
}
export async function fixtureHashes(metadata: RealMetadata) {
    const entries = await Promise.all(['audit-sql.py', 'audit-shell.py', 'challenge.txt'].map(async name =>
        [name, createHash('sha256').update(await readFile(join(metadata.projectDirectory, name))).digest('hex')]));
    return Object.fromEntries(entries);
}
export async function saveReport(root: string, report: unknown): Promise<void> {
    await writeFile(join(root, 'app-runtime-real-model-report.json'), JSON.stringify(report, null, 2) + '\n');
}
