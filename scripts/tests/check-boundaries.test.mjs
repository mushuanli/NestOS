import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { dependencyError, manifestDependencyError, sourceErrors, vfsStyleErrors, importError } from '../check-boundaries.mjs';

const packageGroup = name => name === 'app-shell' ? 'ui/' : ['vfs-ui', 'vfs-core', 'vfs-sync'].includes(name) ? 'libraries/' : 'backend/';
const pkg = (name, host = false) => ({ name: '@itookit/' + name, dir: '/repo/' + (host ? 'apps/' : packageGroup(name)) + name, host, exports: { '.': './src/index.ts', './style.css': './src/style.css' } });
const core = pkg('app-core'), shell = pkg('app-shell'), vfs = pkg('vfs-ui'), host = pkg('web', true);
const packages = [core, shell, vfs, host, pkg('vfs-core'), pkg('vfs-sync')];
const inspect = (source, text, file = source.dir + '/src/index.ts') => sourceErrors(source, file, text, packages);

test('frontend shell cannot import runtime roots or host factories even as a type shortcut', () => {
    for (const expression of ["import type { Runtime } from '@itookit/app-core'", "import { createApplicationRuntime } from '@itookit/app-core'",
        "import('@itookit/app-core/host')"])
        assert.match(inspect(shell, expression)[0], /runtime assembly belongs to hosts/);
});

test('app-shell consumes public VFS events and presentation tokens without internal DOM or CSS selectors', () => {
    assert.match(inspect(shell, "sidebar.querySelector('.vfs-columns__back').click()")[0], /public VFS/);
    assert.match(inspect(shell, "row.classList.contains('vfs-node-item__content')")[0], /public VFS/);
    assert.equal(inspect(shell, 'sidebar.addEventListener(VFS_DOM_EVENTS.resourceActivated, showDetail)').length, 0);
    assert.match(vfsStyleErrors(shell, 'workspace.css', '.toolbox .vfs-node-item__timestamp { display: none; }')[0], /public VFS/);
    assert.equal(vfsStyleErrors(shell, 'workspace.css', '.toolbox { --vfs-item-icon-size: 20px; }').length, 0);
    assert.equal(vfsStyleErrors(vfs, 'style.css', '.vfs-node-item__timestamp { display: none; }').length, 0);
});

test('public execution and conversation capabilities cannot depend on legacy shared contracts', () => {
    for (const source of ['@itookit/tools', '@itookit/device-tty', '@itookit/llm-tasks', '@itookit/llm-flow', '@itookit/llm-session']) {
        for (const target of ['@itookit/common', '@itookit/llm-common'])
            assert.match(dependencyError(source, target), /owned contracts/);
    }
    assert.equal(dependencyError('@itookit/tools', '@itookit/llm-context'), undefined);
    assert.equal(dependencyError('@itookit/device-tty', '@itookit/tools'), undefined);
});

test('dependency direction keeps domain capabilities independent of applications', () => {
    assert.equal(dependencyError(shell.name, core.name), undefined);
    assert.equal(dependencyError(core.name, '@itookit/llm-session'), undefined);
    assert.match(dependencyError(vfs.name, shell.name), /must not depend/);
    assert.match(dependencyError(core.name, vfs.name), /platform-neutral/);
    assert.equal(dependencyError(core.name, 'js-yaml'), undefined);
    assert.match(dependencyError(core.name, 'some-sdk'), /platform-neutral/);
});

test('checks static, dynamic, type-only, re-export and CommonJS dependencies', () => {
    for (const expression of ["import type { X } from '@itookit/app-shell'", "export { X } from '@itookit/app-shell'",
        "import('@itookit/app-shell')", "type X = import('@itookit/app-shell').X", "require('@itookit/app-shell')",
        "import X = require('@itookit/app-shell')"]) assert.equal(inspect(vfs, expression).length, 1, expression);
});

test('allows public CSS exports but rejects private paths and relative package access', () => {
    assert.equal(inspect(shell, "import '@itookit/vfs-ui/style.css'").length, 0);
    assert.match(inspect(shell, "import '@itookit/vfs-ui/src/Store'")[0], /declared package export/);
    assert.match(inspect(shell, "import '../../../libraries/vfs-ui/src/Store'")[0], /cross-package relative/);
    assert.match(inspect(shell, "import '@itookit/web'")[0], /app hosts/);
    assert.equal(inspect(host, "import '@itookit/app-shell'").length, 0);
});

test('keeps native and browser capabilities outside app-core while allowing portable primitives', () => {
    for (const expression of ["import 'node:fs'", "import 'fs'", "import 'react'", "import '@tauri-apps/api/core'", 'window.location', 'globalThis.document',
        'localStorage.getItem("key")', 'let element: HTMLElement']) assert.equal(inspect(core, expression).length, 1, expression);
    assert.equal(inspect(core, 'new AbortController(); new URL("https://example.com"); const value = "window"; // document\n').length, 0);
});

test('public core exports are explicit and comments do not create false dependencies', () => {
    assert.match(inspect(core, "export * from './private'")[0], /must be explicit/);
    assert.equal(inspect(core, "export { Service } from './service'; // import '@itookit/app-shell'\n").length, 0);
    assert.equal(inspect(core, 'const description = "document and HTMLElement";').length, 0);
});


test('standalone mdxeditor has no internal package dependencies', () => {
    for (const name of ['common', 'ui-common', 'vfs-core', 'mdx-adapter']) {
        assert.match(dependencyError('@itookit/mdxeditor', '@itookit/' + name), /public ports/);
    }
    assert.equal(dependencyError('@itookit/mdxeditor', 'codemirror'), undefined);
    assert.equal(dependencyError('@itookit/mdx-adapter', '@itookit/mdxeditor'), undefined);
});

test('standalone vfs-ui only depends on vfs-core internally', () => {
    for (const name of ['common', 'ui-common', 'llm-common', 'mdxeditor'])
        assert.match(dependencyError(vfs.name, '@itookit/' + name), /public ports/);
    assert.equal(dependencyError(vfs.name, '@itookit/vfs-core'), undefined);
    assert.match(dependencyError(vfs.name, 'immer'), /public ports/);
});

test('public LLM mechanisms reject host dependencies', () => {
    for (const name of ['common', 'ui-common', 'vfs-core', 'kernel-adapters/llm', 'llm-session'])
        assert.match(dependencyError('@itookit/driver-llm', '@itookit/' + name), /public ports/);
    assert.match(dependencyError('@itookit/driver-llm', '@itookit/llm-context'), /public ports/);
    assert.match(dependencyError('@itookit/llm-context', '@itookit/driver-llm'), /public ports/);
    const driver = pkg('driver-llm'), context = pkg('llm-context');
    const inspectDriver = text => sourceErrors(driver, '/repo/libraries/driver-llm/src/test.ts', text, [driver, context]);
    assert.equal(inspectDriver("import type { ChatMessage } from '@itookit/llm-context';").length, 1);
    assert.equal(inspectDriver("import { createContextService } from '@itookit/llm-context';").length, 1);
    assert.equal(inspectDriver("import { Client } from 'some-sdk';").length, 1);
});


test('common and shared UI cannot regain hidden LLM dependencies', () => {
    const common = pkg('common'), ui = pkg('ui-common'), session = pkg('llm-session');
    for (const source of [common, ui]) {
        assert.match(dependencyError(source.name, session.name), /capability packages|generic ports/);
        for (const expression of ["import type { ISession } from '@itookit/llm-session'",
            "export * from '@itookit/llm-session'", "type Submission = import('@itookit/llm-session').Signal"])
            assert.equal(sourceErrors(source, source.dir + '/src/index.ts', expression, [common, ui, session]).length, 1);
    }
    assert.equal(dependencyError(ui.name, common.name), undefined);
    assert.equal(dependencyError(ui.name, '@itookit/vfs-core'), undefined);
});

test('kernel adapters cannot depend on the task, flow or session implementations', () => {
    for (const name of ['llm-tasks', 'llm-flow', 'llm-session'])
        assert.match(dependencyError('@itookit/kernel-adapters', '@itookit/' + name), /execution or conversation layers/);
    assert.equal(dependencyError('@itookit/kernel-adapters', '@itookit/tools'), undefined);
});


test('driver dependencies reject context types as well as runtime imports', () => {
    assert.match(manifestDependencyError('@itookit/driver-llm', '@itookit/llm-context'), /no runtime dependencies/);
    assert.match(dependencyError('@itookit/driver-llm', '@itookit/llm-context'), /public ports/);
});

test('optional settings may only load through the explicit settings or compatibility entry', () => {
    const ui = pkg('llm-ui-adapter');
    for (const statement of ["import '@itookit/llm-settings-ui'", "import('./settings')", "export * from './settings'"]) {
        assert.match(inspect(ui, statement, ui.dir + '/src/chat.ts')[0], /optional settings/);
        assert.equal(inspect(ui, statement, ui.dir + '/src/settings.ts').length, 0);
    }
});

test('chat uses session contracts and rejects session implementation imports', () => {
    const ui = pkg('llm-ui-adapter');
    const session = { ...pkg('llm-session'), exports: { '.': './src/index.ts', './contracts': './src/contracts.ts' } };
    const check = (file, expression) => sourceErrors(ui, ui.dir + '/src/' + file, expression, [ui, session]);
    assert.match(check('chat.ts', "import { getSessionManager } from '@itookit/llm-session'")[0], /runtime instances belong to the host/);
    assert.equal(check('chat.ts', "import { SessionCommand } from '@itookit/llm-session/contracts'").length, 0);
    assert.match(check('index.ts', "import { getSessionManager } from '@itookit/llm-session'")[0], /runtime instances belong to the host/);
    assert.match(check('legacy.ts', "import { SessionManager } from '@itookit/llm-session'")[0], /runtime instances belong to the host/);
});


test('chat must receive business flow templates from the host', () => {
    const ui = pkg('llm-ui-adapter');
    assert.match(inspect(ui, "import template from './library/product.flow?raw'", ui.dir + '/src/chat.ts')[0], /template catalogs/);
});


test('public LLM capabilities cannot choose MindOS default tool grants', () => {
    for (const name of ['kernel-adapters', 'llm-session', 'llm-ui-adapter', 'llm-settings-ui']) {
        const source = pkg(name);
        assert.match(inspect(source, "export const DEFAULT_HARNESS_TOOL_IDS = ['Bash'];")[0], /injected policy/);
    }
    assert.equal(inspect(core, "export const DEFAULT_HARNESS_TOOL_IDS = ['Bash'];").length, 0);
});


test('settings cannot load the model management aggregate for config conversion', () => {
    const ui = pkg('llm-settings-ui');
    assert.match(inspect(ui, "import { parseLLMConfig } from '@itookit/kernel-adapters/llm'")[0], /management aggregate/);
});


test('settings use service capabilities instead of process-global MCP state', () => {
    const ui = pkg('llm-settings-ui');
    assert.match(inspect(ui, "import { hasMCPStdioHost } from '@itookit/kernel-adapters/llm/mcp-host'")[0], /service instance capabilities/);
});


test('production hosts cannot rely on implicit LLM presets through the compatibility aggregate', () => {
    for (const source of [pkg('app-core'), pkg('app-shell'), pkg('cli', true)])
        assert.match(inspect(source, "import { LLMDeviceDriver } from '@itookit/kernel-adapters/llm'")[0], /explicit LLM/);
});


test('adapter diagnostics and UI creation state are instance scoped', () => {
    assert.match(dependencyError('@itookit/kernel-adapters', '@itookit/common'), /injected ports/);
    const ui = pkg('llm-ui-adapter');
    assert.match(sourceErrors(ui, ui.dir + '/src/StateManager.ts', "sessionStorage.getItem('app_create_params')", [ui])[0], /instance options/);
});

test('VFS drivers have no sync runtime or type dependencies', () => {
    for (const name of ['vfsdriver-indexeddb', 'vfsdriver-local']) {
        const driver = pkg(name);
        assert.match(manifestDependencyError(driver.name, '@itookit/vfs-sync'), /only depend on vfs-core/);
        assert.match(inspect(driver, "import type { StateStore } from '@itookit/vfs-sync'")[0], /only depend on vfs-core/);
        assert.equal(inspect(driver, "import type { IStorageBackend } from '@itookit/vfs-core'").length, 0);
    }
    assert.match(dependencyError('@itookit/vfs-core', '@itookit/vfs-sync'), /remain independent/);
    assert.equal(dependencyError('@itookit/piagent-driver','@itookit/vfs-sync'),undefined);
    assert.match(dependencyError('@itookit/piagent-driver','@itookit/vfsdriver-agent'),/public ports/);
});

test('UI consumes application capabilities instead of backend construction contracts', () => {
    for (const name of ['LocalBackendPort', 'LocalApplicationServices', 'IVFSManager', 'SessionFilesService', 'DirectoryMountService'])
        assert.match(inspect(shell, `import type { ${name} } from '@itookit/app-contracts/services'`)[0], /construction contracts/);
    assert.equal(inspect(shell, "import type { ApplicationClient } from '@itookit/app-contracts/services'").length, 0);
});
test('RPC mechanism cannot import application metadata or domain policy', () => {
    const file = resolve(host.dir, 'src/rpc/peer.ts');
    for (const specifier of ['../application/capabilities', '@itookit/app-contracts', '../client/projections'])
        assert.match(importError(host, file, specifier, packages), /metadata through injection/);
    assert.equal(importError(host, file, './protocol', packages), undefined);
    assert.equal(importError(host, file, '@itookit/vfs-core', packages), undefined);
});

test('shared RPC transport keeps application descriptors outside its mechanism directory', () => {
    const transport = pkg('app-transport');
    const file = resolve(transport.dir, 'src/rpc/peer.ts');
    assert.match(importError(transport, file, '../application/capabilities', packages), /metadata through injection/);
    assert.equal(importError(transport, file, './protocol', packages), undefined);
});


test('standalone llm-ui rejects all runtime and contract dependencies except mdxeditor', () => {
    const ui = pkg('llm-ui');
    for (const name of ['@itookit/common', '@itookit/llm-ui-adapter', '@itookit/llm-session/contracts', 'marked', 'node:fs']) {
        assert.match(sourceErrors(ui, ui.dir + '/src/index.ts', `import type { Contract } from '${name}'`, [ui])[0], /only import mdxeditor/);
        assert.match(manifestDependencyError(ui.name, name), /only depend on mdxeditor/);
    }
    assert.equal(inspect(ui, "import { MDxRenderer } from '@itookit/mdxeditor'").length, 0);
});
