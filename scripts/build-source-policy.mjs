/** Test suites do not contribute to runtime artifacts or their build fences. */
export function isTestSource(file) {
    const name = file.replaceAll('\\', '/');
    return /(^|\/)(?:tests?|__tests__|__mocks__)(?:\/|$)/.test(name)
        || /\.(?:test|spec)\.[^/]+$/.test(name)
        || /(^|\/)(?:vitest|jest|playwright)\.config\.[^/]+$/.test(name);
}

/** Keep HTTP hosts, workspace code and build metadata; libraries are frozen separately. */
export function isHttpBuildSource(file, toolPackages = new Set()) {
    const name = file.replaceAll('\\', '/');
    if (isTestSource(name) || name.startsWith('libraries/')) return false;
    if (/^(?:doc|docs|\.github)\//.test(name) || /(^|\/)(?:AGENTS|README|CHANGELOG|CONTRIBUTING)(?:\.[^/]+)?$/.test(name)) return false;
    if (/^apps\/(?:tauri-app|demo|cli)\//.test(name)) return /\/package\.json$/.test(name);
    if (name.startsWith('tools/')) return /\/package\.json$/.test(name) || toolPackages.has(name.split('/').slice(0, 2).join('/'));
    return true;
}
