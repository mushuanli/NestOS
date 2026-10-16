import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = await mkdtemp(path.join(tmpdir(), 'itookit-media-cli-'));
const cli = ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url))];
const calls = [];
let observeCrash;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=', 'base64');
const wav = makeWav();
const server = createServer((request, response) => { void serve(request, response).catch(error => { response.writeHead(500); response.end(String(error)); }); });
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const endpoint = `http://127.0.0.1:${server.address().port}`;
try {
    const report = process.argv.includes('--crash-only') ? { success: true, crash: await verifyCrash() } : await verifySuite();
    await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify({ ...report, report: path.join(root, 'report.json') }, null, 2)}\n`);
} finally { await new Promise(resolve => server.close(resolve)); }

async function verifySuccess() {
    const profile = await seed('success');
    const definition = flow();
    const file = await save(profile, 'verify.flow', definition);
    const bindings = await save(profile, 'bindings.json', { illustrations: 'pictures' });
    const run = await invoke(profile, 'run', '-f', file, '--connection-bindings', bindings);
    assert.equal(run.code, 0, run.stderr);
    const ids = await readdir(path.join(profile, 'runs')); assert.equal(ids.length, 1);
    const id = ids[0], status = await invoke(profile, 'status', id), tasks = await invoke(profile, 'tasks', id);
    assert.equal(status.code, 0, status.stderr); assert.equal(tasks.code, 0, tasks.stderr);
    assert.equal(JSON.parse(status.stdout).status, 'succeeded');
    assert.deepEqual(calls.map(call => [call.url, call.model]).sort(), [
        ['/picture-api/v1/images/generations', 'fixture-image'], ['/voice-api/v1/audio/speech', 'fixture-speech'],
    ]);
    const assets = await binaryAssets(profile);
    assert.equal(assets.length, 2);
    for (const asset of assets) assert.equal(path.basename(asset.file), `${createHash('sha256').update(asset.bytes).digest('hex')}.bin`);
    assert.ok(assets.some(asset => asset.bytes.equals(png))); assert.ok(assets.some(asset => asset.bytes.equals(wav)));
    const result = JSON.parse(await readFile(path.join(profile, 'runs', id, 'result.json'), 'utf8'));
    assert.equal(result.picture.assets[0].mimeType, 'image/png'); assert.equal(result.speech.assets[0].mimeType, 'audio/wav');
    const records = JSON.parse(await readFile(path.join(profile, 'runs', id, 'run.json'), 'utf8'));
    const nodes = records.flow.definition.graph.nodes;
    assert.equal(nodes.find(node => node.id === 'picture').config.connectionId, 'pictures');
    assert.equal(nodes.find(node => node.id === 'voice').config.connectionId, 'speech');
    for (const node of nodes.filter(node => node.plugin === 'builtin.media')) assert.ok(node.config.frozenConnection.mediaEndpoint);
    assert.ok(!JSON.stringify(records.flow.definition).includes('fixture-image-secret'));
    const beforeResume = calls.length, resumed = await invoke(profile, 'resume', id);
    assert.equal(resumed.code, 0, resumed.stderr); assert.equal(calls.length, beforeResume);
    return { profile, runId: id, assetCount: assets.length, restoredWithoutRequests: true };
}
async function verifyFailures() {
    const failures = [];
    for (const scenario of ['voice', 'format', 'connection', 'unknown-capability', 'missing-slot']) {
        const isolated = await seed(scenario, scenario === 'unknown-capability'), invalid = flow();
        if (scenario === 'voice') invalid.nodes[1].config.request.voice = 'unknown';
        if (scenario === 'format') invalid.nodes[0].config.request.format = 'webp';
        const invalidBindings = scenario === 'missing-slot' ? {} : { illustrations: scenario === 'connection' ? 'speech' : 'pictures' };
        const invalidFile = await save(isolated, 'invalid.flow', invalid), bindingsFile = await save(isolated, 'bindings.json', invalidBindings);
        const before = calls.length, failed = await invoke(isolated, 'run', '-f', invalidFile, '--connection-bindings', bindingsFile);
        assert.notEqual(failed.code, 0, scenario); assert.equal(calls.length, before, `${scenario} unexpectedly called a model`);
        failures.push({ scenario, exitCode: failed.code, blockedBeforeRequest: true });
    }
    return failures;
}
async function verifySuite() {
    const success = await verifySuccess(), failures = await verifyFailures();
    const httpFailure = await verifyHttpFailure();
    const tools = await verifyTools();
    const frozenRerun = await verifyFrozenRerun();
    const crash = process.argv.includes('--no-crash') ? undefined : await verifyCrash();
    return { success: true, ...success, tools, httpFailure, frozenRerun, crash, models: calls, failures };
}

async function serve(request, response) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const image = request.url === '/picture-api/v1/images/generations';
    assert.equal(request.url, image ? '/picture-api/v1/images/generations' : '/voice-api/v1/audio/speech');
    assert.equal(request.headers.authorization, `Bearer fixture-${image ? 'image' : 'speech'}-secret`);
    assert.equal(body.model, image ? 'fixture-image' : 'fixture-speech');
    calls.push({ url: request.url, model: body.model });
    if (body.prompt === 'FIXTURE_CRASH') { observeCrash?.(response); return; }
    if (body.prompt === 'FIXTURE_HTTP_FAILURE') { response.writeHead(503); response.end('fixture unavailable'); return; }
    if (image) {
        assert.equal(body.output_format, 'png');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } }));
    } else {
        assert.equal(body.voice, 'fixture-voice'); assert.equal(body.response_format, 'wav');
        response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(wav);
    }
}
async function seed(name, unknown = false) {
    const profile = path.join(root, name);
    for (const [id, operation, model, format, output] of [['image', 'image.generate', 'fixture-image', 'png', 'image'], ['speech', 'speech.synthesize', 'fixture-speech', 'wav', 'audio']]) {
        await save(profile, `etc/llm/.providers/${id}.json`, { id, name: id, implementation: 'openai-compatible',
            baseURL: `${endpoint}/${id === 'image' ? 'picture' : 'voice'}-api`, apiKey: `fixture-${id}-secret`, enabled: true,
            media: { [operation]: { adapter: id === 'image' ? 'openai-images' : 'openai-speech' } },
            models: [{ id: model, name: model, category: output, supportsAudio: true, ...(unknown ? {} : { operations: { [operation]: {
                inputModalities: ['text'], outputModalities: [output], formats: [format], ...(id === 'speech' ? { voices: ['fixture-voice'] } : {}),
            } } }) }] });
        await save(profile, `etc/llm/.connections/${id}.json`, { id: id === 'image' ? 'pictures' : 'speech', name: id, providerId: id, enabled: true, tiers: { optimal: model } });
    }
    return profile;
}
function flow() {
    return { id: 'media-cli', name: 'Media CLI verification', draftVersion: 1, updatedAt: 1, edges: [], parameters: [],
        connections: [{ name: 'illustrations', requirements: { operation: 'image.generate' } }], nodes: [
            { id: 'picture', name: 'Picture', plugin: 'builtin.media', pluginVersion: '1.0.0', inputs: {}, config: {
                connectionSlot: 'illustrations', operation: 'image.generate', request: { prompt: 'A geometric square', format: 'png' } } },
            { id: 'voice', name: 'Voice', plugin: 'builtin.media', pluginVersion: '1.0.0', inputs: {}, config: {
                connectionId: 'speech', operation: 'speech.synthesize', request: { input: 'Verification sample', voice: 'fixture-voice', format: 'wav' } } },
            { id: 'result', name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: {
                value: { picture: '${nodes.picture.outputs.result}', speech: '${nodes.voice.outputs.result}' } } },
        ] };
}
async function invoke(profile, ...args) {
    try {
        const result = await promisify(execFile)(process.execPath, [...cli, ...args, '--profile', profile, '--state-dir', profile, '--headless', '--json'], {
            cwd: profile, timeout: 30_000, maxBuffer: 4_000_000, env: fixtureEnvironment(profile),
        });
        return { ...result, code: 0 };
    } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
}
async function save(profile, file, data) {
    const target = path.join(profile, file); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(data, null, 2)); return target;
}
async function binaryAssets(directory) {
    const assets = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) assets.push(...await binaryAssets(file));
        else if (/^[a-f0-9]{64}\.bin$/.test(entry.name)) assets.push({ file, bytes: await readFile(file) });
    }
    return assets;
}
function makeWav() {
    const bytes = Buffer.alloc(44 + 32 * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(64, 40); return bytes;
}

function fixtureEnvironment(profile) {
    return { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'xdg'), MINDOS_LOG_DIR: path.join(profile, 'logs'),
        MINDOS_SESSION_LEASE_TTL_MS: '1500', MINDOS_SCHEDULER_LEASE_TTL_MS: '1500' };
}
async function verifyHttpFailure() {
    const profile = await seed('http-failure'), definition = flow(); definition.nodes = [definition.nodes[0]];
    definition.nodes[0].config.request.prompt = 'FIXTURE_HTTP_FAILURE';
    const file = await save(profile, 'failure.flow', definition), binding = await save(profile, 'bindings.json', { illustrations: 'pictures' });
    const before = calls.length, result = await invoke(profile, 'run', '-f', file, '--connection-bindings', binding);
    assert.notEqual(result.code, 0); assert.equal(calls.length, before + 1);
    return { exitCode: result.code, requests: 1, automaticallyRetried: false };
}
async function verifyTools() {
    const profile = path.join(root, 'tools'); await save(profile, 'placeholder.json', {});
    await writeFile(path.join(profile, 'source.txt'), 'fixture source for deterministic Tool');
    const definition = { id: 'tool-cli', name: 'Tool CLI', draftVersion: 1, updatedAt: 1, connections: [], edges: [], nodes: [{
        id: 'read', name: 'Read', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {}, capabilities: ['Read'],
        config: { toolId: 'Read', toolVersion: '1', approval: 'none', args: { file_path: 'source.txt' } },
    }] };
    const file = await save(profile, 'tool.flow', definition), before = calls.length, result = await invoke(profile, 'run', '-f', file);
    assert.equal(result.code, 0, result.stderr); assert.equal(calls.length, before);
    const ids = await readdir(path.join(profile, 'runs'));
    assert.ok((await readFile(path.join(profile, 'runs', ids[0], 'result.json'), 'utf8')).includes('fixture source'));
    definition.nodes[0].config.toolVersion = 'unavailable';
    const invalid = await save(profile, 'invalid.flow', definition), denied = await invoke(profile, 'run', '-f', invalid);
    assert.notEqual(denied.code, 0); assert.equal(calls.length, before);
    return { succeeded: true, modelRequests: 0, unavailableVersionRejected: true };
}
async function verifyFrozenRerun() {
    const profile = await seed('frozen-rerun'), definition = flow(); definition.nodes = [definition.nodes[0]];
    const file = await save(profile, 'frozen.flow', definition), binding = await save(profile, 'bindings.json', { illustrations: 'pictures' });
    const first = await invoke(profile, 'run', '-f', file, '--connection-bindings', binding);
    assert.equal(first.code, 0, first.stderr);
    const [id] = await readdir(path.join(profile, 'runs'));
    const connectionFile = 'etc/llm/.connections/image.json';
    const connection = JSON.parse(await readFile(path.join(profile, connectionFile), 'utf8'));
    connection.tiers.optimal = 'changed-model'; await save(profile, connectionFile, connection);
    const before = calls.length, rerun = await invoke(profile, 'rerun', id);
    assert.equal(rerun.code, 0, rerun.stderr); assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).model, 'fixture-image');
    const providerFile = 'etc/llm/.providers/image.json';
    const provider = JSON.parse(await readFile(path.join(profile, providerFile), 'utf8'));
    provider.baseURL = `${endpoint}/changed-api`; await save(profile, providerFile, provider);
    const after = calls.length, denied = await invoke(profile, 'rerun', id);
    assert.notEqual(denied.code, 0); assert.match(denied.stdout + denied.stderr, /changed after admission/);
    assert.equal(calls.length, after);
    return { retainedModel: true, changedEndpointRejected: true };
}
async function verifyCrash() {
    const profile = await seed('crash'), definition = flow(); definition.nodes = [definition.nodes[0]];
    definition.nodes[0].config.request.prompt = 'FIXTURE_CRASH';
    const file = await save(profile, 'crash.flow', definition), binding = await save(profile, 'bindings.json', { illustrations: 'pictures' });
    let marker; const observed = new Promise(resolve => { observeCrash = resolve; });
    const child = spawn(process.execPath, [...cli, 'run', '-f', file, '--connection-bindings', binding, '--profile', profile, '--state-dir', profile, '--json', '--headless'],
        { cwd: profile, env: fixtureEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    const exited = new Promise(resolve => child.once('exit', resolve));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
        marker = await Promise.race([observed, exited.then(() => { throw new Error(`CLI exited before media dispatch: ${Buffer.concat(chunks)}`); })]);
        child.kill('SIGKILL'); await exited; marker.destroy();
        await new Promise(resolve => setTimeout(resolve, 31000));
        const [id] = await readdir(path.join(profile, 'runs')), before = calls.length;
        const resumed = await invoke(profile, 'resume', id), tasks = await invoke(profile, 'tasks', id);
        assert.notEqual(resumed.code, 0, resumed.stdout + resumed.stderr);
        assert.match(resumed.stdout + resumed.stderr + tasks.stdout, /indeterminate/i); assert.equal(calls.length, before);
        return { runId: id, exitCode: resumed.code, indeterminate: true, replayedRequests: 0 };
    } finally { clearTimeout(timeout); observeCrash = undefined; marker?.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
