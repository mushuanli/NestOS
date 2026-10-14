#!/usr/bin/env node
/**
 * 文档与代码同步检查（活文档专用）。
 *
 * 检查三类问题：
 *   1. 已删除的符号仍出现在活文档中（重构后未同步；"取代/已删除/旧"等历史表述仅告警）；
 *   2. 反引号里的仓库文件路径不存在（悬空引用）；
 *   3. 相对 Markdown 链接失效。
 *
 * 活文档 = doc/*.md + doc/design/*.md + AGENTS.md + packages/AGENTS.md + packages/ * /AGENTS.md + packages/ * /doc/*.md + packages|apps 的 README.md。
 * doc/feat/ 与 doc/deprecated/ 是归档，不参与检查。
 *
 * 用法：node scripts/check-docs.mjs   （或 pnpm docs:check）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TOP_DIRS = ['libraries', 'packages', 'apps', 'doc', 'scripts', 'tests'];

/** 已被删除/更名的符号：活文档中不应再出现（历史表述仅告警）。 */
const REMOVED_SYMBOLS = [
    'IModuleFS', 'ModuleDriver', 'ModuleContext', 'BaseModuleService',
    'IChatEngine', 'ChatEngine', 'FlowAssetStore', 'FS_MODULE_CHAT',
    'chat-engine.ts', 'chat-kernel-storage', 'CHAT_HARNESS_STORAGE_KIND',
    'ChatKernelStorageResolver', 'chatKernelStorage',
    'updateBoundNodeId', 'getSessionNodeId', 'getSessionIdFromNodeId', 'initializeExistingFile',
    'llm-runtime', 'AssemblyInput', 'DependencyCollector',
    'module:mounted', 'module:unmounted', 'session.closed', 'effect.succeeded',
    'session.message.delivered', 'app-shell/src/strategies', 'llm-ui/src/editors/',
];
const HISTORICAL_CONTEXT = /(取代|替代|已删除|已移除|更名|旧|原|历史|迁移|归档|没有|不再|不存在|弃用)/;
/** 允许出现在文档中的非仓库路径（示例、外部路径、占位符）。 */
const EXTERNAL_PATH = /[<>{}*…]|^[a-z]+:\/\//;

function collectDocs() {
    const docs = ['AGENTS.md', 'packages/AGENTS.md'];
    for (const name of readdirSync(join(ROOT, 'doc'))) {
        if (name.endsWith('.md') && statSync(join(ROOT, 'doc', name)).isFile()) docs.push(`doc/${name}`);
    }
    for (const name of readdirSync(join(ROOT, 'doc/design'))) {
        if (name.endsWith('.md')) docs.push(`doc/design/${name}`);
    }
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
        if (existsSync(join(ROOT, 'packages', pkg, 'AGENTS.md'))) docs.push(`packages/${pkg}/AGENTS.md`);
        if (existsSync(join(ROOT, 'packages', pkg, 'README.md'))) docs.push(`packages/${pkg}/README.md`);
        const docDir = join(ROOT, 'packages', pkg, 'doc');
        if (!existsSync(docDir)) continue;
        for (const name of readdirSync(docDir)) {
            if (name.endsWith('.md')) docs.push(`packages/${pkg}/doc/${name}`);
        }
    }
    for (const app of readdirSync(join(ROOT, 'apps'))) {
        if (existsSync(join(ROOT, 'apps', app, 'README.md'))) docs.push(`apps/${app}/README.md`);
    }
    return docs.sort();
}

function workspaceDirs() {
    const dirs = [];
    for (const base of ['libraries', 'packages', 'apps']) {
        for (const name of readdirSync(join(ROOT, base))) {
            if (statSync(join(ROOT, base, name)).isDirectory()) dirs.push(`${base}/${name}`);
        }
    }
    return dirs;
}

const WORKSPACE_DIRS = workspaceDirs();
const WORKSPACE_NAMES = WORKSPACE_DIRS.map(dir => dir.split('/')[1]);

/** 只校验"看起来是仓库路径"的引用；概念路径（如 `_agent/AGENT.md`）不校验。 */
function isRepoReference(ref) {
    if (EXTERNAL_PATH.test(ref) || ref.startsWith('/')) return false;
    if (!ref.includes('/')) return false;
    const head = ref.split('/')[0];
    return TOP_DIRS.includes(head) || WORKSPACE_NAMES.includes(head) || ref.includes('/src/');
}

function resolveReference(doc, ref) {
    const candidates = [ref, join(dirname(doc), ref)];
    const head = ref.split('/')[0];
    if (TOP_DIRS.includes(head)) return candidates.some(candidate => existsSync(resolve(ROOT, candidate)));
    if (WORKSPACE_NAMES.includes(head)) {
        const rest = ref.slice(head.length + 1);
        candidates.push(`libraries/${head}/${rest}`, `libraries/${head}/src/${rest}`,
            `packages/${head}/${rest}`, `packages/${head}/src/${rest}`,
            `apps/${head}/${rest}`, `apps/${head}/src/${rest}`);
    }
    candidates.push(`libraries/${ref}`, `packages/${ref}`, `apps/${ref}`);
    for (const dir of WORKSPACE_DIRS) candidates.push(`${dir}/${ref}`, `${dir}/src/${ref}`);
    return candidates.some(candidate => existsSync(resolve(ROOT, candidate)));
}

const PATH_REF = /`([A-Za-z0-9_@./-]+\/[A-Za-z0-9_@./-]+\.(?:ts|tsx|js|mjs|md|json|css|rs|yml|yaml|toml))`/g;
const MD_LINK = /\]\(([^)\s]+?)(?:#[^)]*)?\)/g;

const errors = [];
const warnings = [];
for (const doc of collectDocs()) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    text.split('\n').forEach((line, index) => {
        const where = `${doc}:${index + 1}`;
        for (const symbol of REMOVED_SYMBOLS) {
            const pattern = new RegExp(`(^|[^A-Za-z0-9_])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);
            if (pattern.test(line)) (HISTORICAL_CONTEXT.test(line) ? warnings : errors).push(`[removed-symbol] ${where} → ${symbol}`);
        }
        for (const match of line.matchAll(PATH_REF)) {
            const ref = match[1];
            if (!isRepoReference(ref)) continue;
            if (!resolveReference(doc, ref)) errors.push(`[dangling-path] ${where} → ${ref}`);
        }
        for (const match of line.matchAll(MD_LINK)) {
            const target = match[1];
            if (/^(?:https?:|mailto:|#)/.test(target)) continue;
            if (!existsSync(resolve(ROOT, dirname(doc), target))) errors.push(`[broken-link] ${where} → ${target}`);
        }
    });
}

// A package without its own AGENTS.md silently drops out of this check (collectDocs
// only adds existing files), so surface the gap instead of hiding it.
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (!existsSync(join(ROOT, 'packages', pkg, 'package.json'))) continue;
    if (!existsSync(join(ROOT, 'packages', pkg, 'AGENTS.md'))) warnings.push(`[missing-doc] packages/${pkg}/AGENTS.md`);
}

for (const warning of warnings) console.warn(`  告警 ${warning}`);
if (errors.length) {
    console.error(`\n文档同步检查失败：${errors.length} 处问题\n`);
    for (const error of errors) console.error(`  ${error}`);
    console.error('\n修正后重跑：pnpm docs:check');
    process.exit(1);
}
console.log(`文档同步检查通过（${collectDocs().length} 份活文档，${warnings.length} 条历史表述告警）`);
