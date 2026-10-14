#!/usr/bin/env node
// @file: scripts/check-styles.mjs
// Guards against markup referencing CSS classes that no stylesheet defines.
//
// A class with no rule is invisible to review: form controls fall back to the
// platform theme (on Linux/WebKitGTK an unstyled input renders as a borderless
// near-white band), layout containers lose their flex/grid arrangement, and the
// defect only surfaces on the machine where the fallback happens to look broken.
//
// Usage:
//   node scripts/check-styles.mjs            # report, exit 1 on new orphans
//   node scripts/check-styles.mjs --list     # print every orphan (no exit code)
//
// Allowlist: scripts/style-class-allowlist.txt (one class per line, '#' comments).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'target', 'vendor', '__tests__', 'tests', 'test', 'demo', 'coverage']);
const MARKUP_EXT = /\.(ts|js|mjs|html)$/;
const ALLOWLIST = join(ROOT, 'scripts/style-class-allowlist.txt');

// Behaviour/state hooks and icon-font classes carry no layout of their own.
const HOOK_PATTERN = /^(?:fa-|fas$|far$|fab$|is-|has-|active$|selected$|hidden$|collapsed$|dragging$|loading$|open$|disabled$)/;

function walk(dir, visit) {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, visit);
        else visit(path);
    }
}

const cssFiles = [];
const markupFiles = [];
for (const group of ['libraries', 'packages', 'apps']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    walk(base, path => {
        if (path.endsWith('.css')) cssFiles.push(path);
        else if (MARKUP_EXT.test(path)) markupFiles.push(path);
    });
}

const defined = new Set();
const dynamicPrefixes = new Set();
const addSelectors = text => {
    for (const match of text.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) defined.add(match[1]);
    // BEM modifier placeholders such as `.llm-ui-node__status--${status}` are
    // completed at runtime; treat the `block--` stem as covered.
    for (const match of text.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*--)(?![a-zA-Z0-9-])/g)) dynamicPrefixes.add(match[1]);
};
for (const file of cssFiles) addSelectors(readFileSync(file, 'utf8'));
// Some components inject their stylesheet at runtime (injectStyle / <style>).
// Treat class selectors that open a rule block inside markup sources as defined.
for (const file of markupFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)(?=[^{};]*\{)/g)) defined.add(match[1]);
}

const allowlist = new Set(
    existsSync(ALLOWLIST)
        ? readFileSync(ALLOWLIST, 'utf8').split('\n').map(line => line.split('#')[0].trim()).filter(Boolean)
        : [],
);

const orphans = new Map(); // class -> Set(file)
const record = (token, file) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) return;
    // Runtime-composed fragments (`llm-ui-node--${status}`, `sort-${key}`) are
    // only a prefix in the source; the concrete class is assembled at runtime.
    if (/-$/.test(token)) return;
    if (defined.has(token) || allowlist.has(token) || HOOK_PATTERN.test(token)) return;
    if ([...dynamicPrefixes].some(prefix => token.startsWith(prefix))) return;
    if (!orphans.has(token)) orphans.set(token, new Set());
    orphans.get(token).add(relative(ROOT, file));
};

for (const file of markupFiles) {
    const text = readFileSync(file, 'utf8');
    // Static markup: skip tags that style themselves inline on purpose.
    for (const match of text.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const tag = match[0];
        if (/\sstyle=/.test(tag)) continue;
        const classAttr = tag.match(/class="([^"]*)"/);
        if (!classAttr) continue;
        for (const raw of classAttr[1].split(/\s+/)) {
            record(raw.replace(/\$\{.*/, '').replace(/\$\{.*$/, ''), file);
        }
    }
    // Runtime class assignment (className / classList) — no inline style context.
    for (const match of text.matchAll(/(?:className\s*=\s*|classList\.(?:add|toggle|remove)\()['"`]([^'"`]*)/g)) {
        for (const raw of match[1].split(/\s+/)) record(raw.replace(/\$\{.*/, ''), file);
    }
}

const entries = [...orphans].sort(([a], [b]) => a.localeCompare(b));
const listOnly = process.argv.includes('--list');
console.log(`styles:check — ${cssFiles.length} stylesheets, ${markupFiles.length} markup files, ${defined.size} defined classes, ${allowlist.size} allowlisted`);
if (entries.length === 0) {
    console.log('no unstyled markup classes');
    process.exit(0);
}
console.log(`${entries.length} markup class(es) have no CSS rule:`);
for (const [cls, files] of entries) console.log(`  ${cls}  <-  ${[...files].slice(0, 3).join(', ')}`);
if (listOnly) process.exit(0);
console.log('\nAdd a rule, drop the class, or allowlist it in scripts/style-class-allowlist.txt.');
process.exit(1);
