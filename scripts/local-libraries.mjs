#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import state from './local-library-state.mjs';
import { prepareSnapshot } from './local-library-build.mjs';
import { checkWorkspace } from './check-workspace.mjs';
import { preparedSnapshot } from './local-library-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const operationId = randomUUID();
function stage(name, action) {
    const start = Date.now();
    console.log(`[local-libraries] operationId=${operationId} stage=${name} result=start`);
    try {
        const value = action();
        console.log(`[local-libraries] operationId=${operationId} stage=${name} result=success durationMs=${Date.now() - start}`);
        return value;
    } catch (error) {
        console.error(`[local-libraries] operationId=${operationId} stage=${name} result=failure durationMs=${Date.now() - start} code=${error.code ?? error.status ?? 'unknown'} reason=${error.message}`);
        throw error;
    }
}

function install(choice) {
    execFileSync('pnpm', ['install', '--prefer-offline', '--no-frozen-lockfile'], { cwd: root, stdio: 'inherit',
        env: { ...process.env, NESTOS_LIBRARY_SNAPSHOT: choice, CI: 'true' } });
    const errors = checkWorkspace(root, { installed: true, snapshot: state.readSelection(root, choice) });
    if (errors.length) throw new Error(`LOCAL_LIBRARIES_RESOLUTION: ${errors.join('\n')}`);
}

function activate(choice) {
    const selected = state.readSelection(root, choice), file = state.activeFile(root);
    const previous = state.readSelection(root), previousChoice = previous?.id ?? 'source';
    if (!selected && previous && !existsSync(join(state.localRoot(root), 'prepared.json'))) rememberPrepared(previous);
    try {
        stage('install-and-verify', () => install(choice));
        const temporary = `${file}.${operationId}.tmp`;
        mkdirSync(state.localRoot(root), { recursive: true });
        writeFileSync(temporary, JSON.stringify({ format: 1, mode: selected ? 'snapshot' : 'source', ...(selected && { id: selected.id }) }, null, 2) + '\n');
        renameSync(temporary, file);
    } catch (error) {
        try { stage('rollback', () => install(previousChoice)); }
        catch (rollback) { throw new AggregateError([error, rollback], 'LOCAL_LIBRARIES_ROLLBACK_FAILED: restore dependencies before restarting development'); }
        throw error;
    }
    console.log(`Active libraries: ${selected?.id ?? 'source'}; restart running development servers.`);
}

function status() {
    const snapshot = state.readSelection(root);
    console.log(`Active libraries: ${snapshot?.id ?? 'source'}`);
    console.log(`HTTP build snapshot: ${preparedSnapshot(root)?.id ?? 'none; run pnpm lib:build'}`);
    for (const item of snapshot?.packages ?? []) console.log(`${item.name}@${item.version} ${item.sha256}`);
    const errors = checkWorkspace(root, { installed: true, snapshot });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Installed dependencies match the selected mode.');
}
function rememberPrepared(snapshot) {
    const file = join(state.localRoot(root), 'prepared.json'), temporary = `${file}.${operationId}.tmp`;
    writeFileSync(temporary, JSON.stringify({ format: 1, id: snapshot.id }) + '\n');
    renameSync(temporary, file);
}

function main() {
    const [command, choice] = process.argv.slice(2);
    if (command === 'status') return status();
    if (!['snapshot', 'build', 'use', 'source'].includes(command)) throw new Error('Usage: local-libraries.mjs build [library] | snapshot | use <full-id> | source | status');
    if (process.argv.length > 4 || (command === 'snapshot' && choice)) throw new Error('LOCAL_LIBRARIES_ARGUMENTS: use build [library] to select a library');
    if (command === 'use' && !choice) throw new Error('LOCAL_LIBRARIES_ID: provide the full snapshot identity');
    const lock = join(state.localRoot(root), 'operation.lock');
    mkdirSync(state.localRoot(root), { recursive: true });
    // Fail closed when another capture or switch owns the workspace.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, operationId }), { flag: 'wx' });
    try {
        if (command === 'snapshot' || command === 'build') {
            const snapshot = prepareSnapshot(root, operationId, stage, { incremental: command === 'build', requested: choice });
            rememberPrepared(snapshot);
            console.log(`HTTP build snapshot prepared: ${snapshot.id}\nDevelopment dependencies unchanged. Run pnpm httpd:build to consume it.`);
        } else activate(command === 'source' ? 'source' : choice);
    } finally { rmSync(lock, { force: true }); }
}

try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
