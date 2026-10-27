import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'vite';

// Compile actual Tauri event imports through the production Vite configuration.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'nestos-ipc-build-'));
try {
    const entry = path.join(temporary, 'entry.js');
    await writeFile(entry, `
        import { listen } from ${JSON.stringify(path.join(root, 'node_modules/@tauri-apps/api/event.js'))};
        import { Resource, checkPermissions, requestPermissions, addPluginListener } from '@tauri-apps/api/core';
        import { ipcCounter } from ${JSON.stringify(path.join(root, 'src/log/traced-core.ts'))};
        export async function exercise() {
            const unlisten = await listen('trace-probe', () => {});
            await unlisten();
            await new Resource(17).close();
            await checkPermissions('probe');
            await requestPermissions('probe');
            const listener = await addPluginListener('probe', 'event', () => {});
            await listener.unregister();
            await ipcCounter.uncounted('diagnostic');
            return ipcCounter.snapshot();
        }
    `);
    for (const enabled of [true, false]) {
    const result = await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
        define: { 'import.meta.env.VITE_NESTOS_TRACE': JSON.stringify(enabled ? '1' : '0') },
        plugins: [{ name: 'probe-single-chunk', configResolved(config) {
            delete config.build.rollupOptions.output.manualChunks;
        } }],
        build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'Probe' },
            rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: true } } } });
    const output = (Array.isArray(result) ? result[0] : result).output;
    const chunk = output.find(item => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk, 'Expected a compiled entry chunk');
    const calls = [];
    const context = { window: { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: Object.freeze({
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: async command => { calls.push(command); if (command === 'plugin:probe|register_listener') throw new Error('use fallback'); return 7; },
    }) } };
    runInNewContext(chunk.code, context);
    const counts = await context.Probe.exercise();
    const expected = ['plugin:event|listen', 'plugin:event|unlisten', 'plugin:resources|close',
        'plugin:probe|check_permissions', 'plugin:probe|request_permissions', 'plugin:probe|register_listener',
        'plugin:probe|registerListener', 'plugin:probe|remove_listener'];
    assert.deepEqual(calls, [...expected, 'diagnostic']);
    if (enabled) for (const command of expected) assert.equal(counts[command], 1, command);
    assert.equal(Object.keys(counts).length, enabled ? expected.length : 0);
    assert.equal(counts.diagnostic, undefined);
    }
    console.log('Trace on/off: public, relative and internal core requests counted exactly once; failed fallback counted; diagnostics excluded.');
} finally { await rm(temporary, { recursive: true, force: true }); }
