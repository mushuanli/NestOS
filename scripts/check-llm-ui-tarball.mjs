import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = mkdtempSync(resolve(tmpdir(), 'llm-ui-tarball-'));
const artifacts = resolve(directory, 'artifacts'), consumer = resolve(directory, 'consumer');
mkdirSync(artifacts); mkdirSync(consumer);
function run(command, args, cwd = root, env = {}) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed; retained ${directory}`);
}
for (const name of ['llm-ui', 'mdxeditor']) run('pnpm', ['--filter', `@itookit/${name}`, 'pack', '--out', resolve(artifacts, `${name}.tgz`)], root,
    { npm_config_ignore_scripts: 'true' });
writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@10.20.0', dependencies: {
    '@itookit/llm-ui': 'file:../artifacts/llm-ui.tgz', '@itookit/mdxeditor': 'file:../artifacts/mdxeditor.tgz',
}, devDependencies: { typescript: '5.9.3', vite: '5.4.21', jsdom: '27.2.0' } }, null, 2));
writeFileSync(resolve(consumer, 'pnpm-workspace.yaml'), 'packages: ["."]\noverrides:\n  "@itookit/mdxeditor": "file:../artifacts/mdxeditor.tgz"\n');
run('pnpm', ['install', '--ignore-scripts', ...(process.argv.includes('--online') ? [] : ['--offline'])], consumer);
for (const name of ['llm-ui', 'mdxeditor']) assert.ok(realpathSync(resolve(consumer, 'node_modules/@itookit', name)).startsWith(consumer + '/'));
writeFileSync(resolve(consumer, 'main.ts'), `
import { createChatView, createOperationLedger, type ChatOptions } from '@itookit/llm-ui';
import { createFlowView, type FlowSnapshot } from '@itookit/llm-ui/flow';
import '@itookit/llm-ui/style.css';
import '@itookit/llm-ui/flow.css';
import '@itookit/mdxeditor/style.css';
export { createChatView, createOperationLedger, createFlowView };
export type { ChatOptions, FlowSnapshot };
`);
writeFileSync(resolve(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext',
    moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true, lib: ['ES2022', 'DOM'] }, include: ['main.ts'] }));
run('pnpm', ['exec', 'tsc'], consumer);
writeFileSync(resolve(consumer, 'vite.config.mjs'), `export default { build: { target: 'esnext', lib: { entry: 'main.ts', fileName: 'consumer', formats: ['es'] } } };`);
run('pnpm', ['exec', 'vite', 'build'], consumer);
cpSync(resolve(root, 'libraries/llm-ui/src'), resolve(consumer, 'source/src'), { recursive: true });
writeFileSync(resolve(consumer, 'source-main.ts'), `
export { createChatView, createOperationLedger } from './source/src/index';
export { createFlowView } from './source/src/flow';
`);
writeFileSync(resolve(consumer, 'source-tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext',
    moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'] }, include: ['source-main.ts'] }));
run('pnpm', ['exec', 'tsc', '-p', 'source-tsconfig.json'], consumer);
writeFileSync(resolve(consumer, 'vite.source.config.mjs'), `export default { build: { target: 'esnext', outDir: 'source-dist', lib: { entry: 'source-main.ts', fileName: 'source-consumer', formats: ['es'] } } };`);
run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.source.config.mjs'], consumer);
writeFileSync(resolve(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<main id="chat"></main><main id="flow"></main>', { pretendToBeVisual: true });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'Element', 'Node', 'DOMParser', 'MutationObserver', 'AbortController', 'AbortSignal', 'getComputedStyle'])
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const { createChatView, createOperationLedger } = await import('@itookit/llm-ui');
const { createFlowView } = await import('@itookit/llm-ui/flow');
const operations = createOperationLedger(), listeners = new Set(), flowListeners = new Set();
let snapshot = { conversationId: 'c', viewId: 'v', revision: 0, title: 'Chat', messages: [], interactions: [],
    loading: false, execution: 'idle', connection: 'online', hasEarlier: false, allowed: ['send'] };
const flowOptions = { source: { getSnapshot: () => ({ flowId: 'f', viewId: 'fv', revision: 0, graphRevision: 0,
    title: 'Flow', nodes: [], edges: [], nodeTypes: [], allowed: [], loading: false }),
    subscribe: callback => { flowListeners.add(callback); return () => flowListeners.delete(callback); } }, actions: {}, operations };
const view = await createChatView(document.querySelector('#chat'), {
    source: { getSnapshot: () => snapshot, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } },
    actions: { async send(input, context) {
        snapshot = { ...snapshot, revision: snapshot.revision + 1, messages: [{ id: 'message', revision: 0, role: 'user',
            state: 'complete', submissionId: context.operationId, acceptance: 'confirmed', parts: [{ id: 'text', kind: 'markdown', text: input.text }] }] };
        listeners.forEach(callback => callback()); return { status: 'accepted', operationId: context.operationId };
    }, reconcile: async operationId => ({ status: 'unknown', operationId, message: '?' }) }, operations, flow: flowOptions,
});
view.setText('Standalone'); await view.submit(); assert.equal(view.getDraft().text, '');
await view.setFlowEnabled(true);
[...document.querySelectorAll('#chat button')].find(node => node.textContent === 'Flow').click();
for (let i = 0; i < 50 && !document.querySelector('#chat .llm-flow'); i++) await new Promise(resolve => setTimeout(resolve, 10));
assert.ok(document.querySelector('#chat .llm-flow'), 'lazy Flow module loads from the tarball');
await view.setFlowEnabled(false); assert.equal(flowListeners.size, 0);
const flow = await createFlowView(document.querySelector('#flow'), flowOptions); await flow.destroy(); await view.destroy();
assert.equal(listeners.size, 0); assert.equal(flowListeners.size, 0);
assert.equal(typeof createRequire(import.meta.url)('@itookit/llm-ui').createChatView, 'function');
dom.window.close(); console.log('Tarball Chat, lazy Flow, lifecycle and CJS smoke passed.');
`);
run('node', ['smoke.mjs'], consumer);
process.stdout.write(`Independent tarball typecheck, build and runtime smoke passed: ${directory}\n`);
