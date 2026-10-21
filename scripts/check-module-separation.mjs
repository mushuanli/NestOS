import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { workspacePackages, sourceExports } from './workspace-packages.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const frontend = ['app-shell', 'app-settings', 'llm-ui', 'llm-ui-adapter', 'llm-settings-ui', 'mdx-adapter', 'ui-common', 'vfs-ui', 'image-parser', 'mdxeditor'];
const backend = ['app-core', 'llm-context', 'llm-session', 'llm-flow', 'llm-tasks', 'durable-kernel', 'kernel-adapters', 'tools', 'device-tty', 'sanbox', 'sync-adapters'];
const shared = ['app-contracts', 'common', 'app-transport'];

/** Inspect emitted imports, including lazy imports, without relying on tree shaking. */
export function runtimeSpecifiers(source, filename = 'module.ts') {
    const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    } }).outputText;
    const file = ts.createSourceFile(filename, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = new Set();
    function visit(node) {
        const value = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
            : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(file) === 'require') ? node.arguments[0] : undefined;
        if (value && ts.isStringLiteralLike(value)) names.add(value.text);
        ts.forEachChild(node, visit);
    }
    visit(file); return [...names];
}

/** Include type references to prevent UI coupling to concrete application implementations. */
export function contractSpecifiers(source, filename = 'module.ts') {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const names = new Set();
    function visit(node) {
        const value = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
        if (value && ts.isStringLiteralLike(value)) names.add(value.text);
        ts.forEachChild(node, visit);
    }
    visit(file); return [...names];
}

function contractErrors(roots, role, root) {
    const entries = publicEntries(root), errors = [];
    for (const file of roots) {
        for (const name of contractSpecifiers(readFileSync(file, 'utf8'), file)) {
            const target = resolveImport(file, name, entries);
            const core = name === '@itookit/app-core' || name.startsWith('@itookit/app-core/')
                || (target && relative(root, target).replaceAll('\\', '/').startsWith('backend/app-core/'));
            const frontend = target && moduleRole(target, root) === 'frontend';
            if ((role !== 'backend' && core) || (role !== 'frontend' && frontend))
                errors.push(`${role} references implementation contract: ${relative(root, file)} -> ${name}`);
        }
    }
    return errors;
}

export function directoryErrors(root = repository) {
    const groups = new Map([...frontend.map(name => [name, ['vfs-ui', 'image-parser', 'mdxeditor', 'llm-ui'].includes(name) ? 'libraries' : 'ui']), ...backend.map(name => [name, ['durable-kernel', 'device-tty'].includes(name) ? 'libraries' : 'backend']), ...shared.map(name => [name, 'shared'])]);
    const legacy = resolve(root, 'packages');
    const misplaced = existsSync(legacy) ? readdirSync(legacy).filter(name => existsSync(resolve(legacy, name, 'package.json'))) : [];
    return [...misplaced.map(name => `packages/${name} must move to ui/, backend/, shared/ or apps/`), ...workspacePackages(root).flatMap(pkg => {
        const group = groups.get(pkg.name.replace('@itookit/', ''));
        return group && pkg.group !== group ? [`${pkg.name} belongs in ${group}/, found in ${pkg.group}/`] : [];
    })];
}

function sourceFiles(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.[cm]?[jt]sx?$/.test(path) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : [];
    });
}

export function moduleRole(path, root = repository) {
    const file = relative(root, path).replaceAll('\\', '/');
    if (file.startsWith('apps/node-host/src/')) return 'backend';
    if (file.startsWith('apps/http-app/src/client/')) return 'frontend';
    if (file.startsWith('apps/http-app/src/server/') || file.startsWith('apps/web-app/src/storage/') || file.startsWith('apps/cli/src/')) return 'backend';
    const match = /^(ui|backend|shared|packages|libraries|tools)\/([^/]+)\/src\/(.*)$/.exec(file);
    if (!match) return undefined;
    const [, group, name, tail] = match;
    if (group === 'ui') return 'frontend';
    if (group === 'shared') return 'shared';
    if (group === 'tools') return name === 'image-tools' && tail === 'browser.ts' ? 'host' : tail === 'contract.ts' ? 'shared' : 'backend';
    if (group === 'libraries') {
        if (name === 'image-parser' && /^(processing|policy|validation|contracts)\.ts$/.test(tail)) return 'shared';
        if (['vfs-ui', 'image-parser', 'mdxeditor', 'llm-ui'].includes(name)) return 'frontend';
        if (name === 'vfs-core') return 'shared';
        if (name === 'durable-kernel') return tail === 'contracts.ts' ? 'shared' : 'backend';
        if (name === 'device-tty') return tail === 'contracts.ts' ? 'shared' : 'backend';
        if (name === 'driver-llm' && (tail === 'contracts.ts' || tail.startsWith('types/'))) return 'shared';
        if (['driver-llm', 'mindos-node-driver', 'vfs-sync'].includes(name) || name.startsWith('vfsdriver-')) return 'backend';
        return undefined;
    }
    if (frontend.includes(name)) return 'frontend';
    if (shared.includes(name)) return 'shared';
    if (group !== 'backend' && !backend.includes(name)) return undefined;
    if (tail.endsWith('contracts.ts') || tail.startsWith('contracts/') || tail.includes('/contracts/') || tail === 'flow/command-names.ts') return 'shared';
    // Configuration codecs are deliberately independent of devices, drivers and product presets.
    if (name === 'kernel-adapters' && /^(llm-management\/(config|compose-presets)|llm-management\/constants\/llm-loader)/.test(tail)) return 'shared';
    return 'backend';
}

function publicEntries(root) {
    return new Map(workspacePackages(root).flatMap(pkg => sourceExports(pkg)
        .map(([specifier, entry]) => [specifier, resolve(pkg.directory, entry)])));
}
function resolveImport(file, name, entries) {
    if (entries.has(name)) return entries.get(name);
    if (!name.startsWith('.')) return undefined;
    const base = resolve(dirname(file), name.replace(/\.js$/, ''));
    return [base, base + '.ts', base + '.tsx', base + '.js', resolve(base, 'index.ts')].find(path => existsSync(path) && !readdirSafe(path));
}
function readdirSafe(path) {
    try { readdirSync(path); return true; } catch { return false; }
}

/** Return every reachable repository module and its import chain. */
export function runtimeGraph(roots, root = repository) {
    const entries = publicEntries(root), graph = new Map(), pending = roots.map(path => [path, []]);
    while (pending.length) {
        const [raw, parents] = pending.pop();
        const file = realpathSync(raw);
        if (graph.has(file) || !/\.[cm]?[jt]sx?$/.test(file)) continue;
        const chain = [...parents, file]; graph.set(file, chain);
        for (const name of runtimeSpecifiers(readFileSync(file, 'utf8'), file)) {
            const target = resolveImport(file, name, entries);
            if (target) pending.push([target, chain]);
        }
    }
    return graph;
}

export function separationErrors(root = repository) {
    const errors = directoryErrors(root);
    for (const [role, forbidden] of [['frontend', 'backend'], ['backend', 'frontend'], ['shared', 'backend']]) {
        const roots = workspacePackages(root)
            .filter(pkg => moduleRole(resolve(pkg.directory, 'src/index.ts'), root) === role)
            .flatMap(pkg => sourceFiles(resolve(pkg.directory, 'src')).filter(file => moduleRole(file, root) !== 'host'));
        if (role === 'frontend') roots.push(...sourceFiles(resolve(root, 'apps/http-app/src/client')));
        if (role === 'backend') roots.push(...sourceFiles(resolve(root, 'apps/http-app/src/server')), ...sourceFiles(resolve(root, 'apps/cli/src')));
        errors.push(...contractErrors(roots, role, root));
        for (const [file, chain] of runtimeGraph(roots, root)) {
            const target = moduleRole(file, root);
            if (target !== forbidden && !(role === 'shared' && target === 'frontend')) continue;
            errors.push(`${role} loads ${target}: ${chain.map(path => relative(root, path)).join(' -> ')}`);
        }
    }
    return errors;
}

/** Check the actual bundler graph, after TypeScript erasure and lazy-import discovery. */
export function moduleSeparationPlugin(role) {
    return {
        name: 'itookit-module-separation',
        apply: 'build',
        buildEnd(error) {
            if (error) return;
            const forbidden = role === 'frontend' ? 'backend' : 'frontend';
            const modules = [...this.getModuleIds()].filter(id => !id.startsWith('\0'));
            const violations = modules.filter(id => moduleRole(id.split('?')[0]) === forbidden);
            if (violations.length) this.error(`${role} bundle loads ${forbidden} implementations:\n${violations.map(id => relative(repository, id)).join('\n')}`);
        },
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const errors = separationErrors();
    if (errors.length) { process.stderr.write(errors.join('\n') + '\n'); process.exitCode = 1; }
    else process.stdout.write('Frontend, backend and shared directories, application contracts and runtime graphs are separated.\n');
}
