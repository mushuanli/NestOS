import {FSError, normalizeVirtualPath, type IFileSystem} from '@itookit/vfs-core';

const sensitive = new Set(['apiKey', 'accessToken', 'refreshToken', 'idToken', 'clientSecret', 'password', 'token', 'headers', 'env', 'args']);
/** Read-only consumers receive configuration metadata; execution retains the original service. */
export function publicConfiguration<T extends object>(service: T): T {
    return new Proxy(service, {get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (['getFullProvider', 'getMCPServers', 'getSkills'].includes(String(key)))
            return async (...args: unknown[]) => redact(await value.apply(target, args));
        return value.bind(target);
    }});
}
function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.has(key)).map(([key, entry]) => [key,
        /url$/i.test(key) && typeof entry === 'string' ? publicUrl(entry) : redact(entry)]));
}
function publicUrl(value: string): string {
    try {const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString();}
    catch {return '';}
}
/** Raw shared LLM documents contain credentials; their public projections are exposed separately. */
export function privateConfigurationFiles(fs: IFileSystem): IFileSystem {
    const protect = <T extends object>(api: T): T => new Proxy(api, {get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
            if (containsConfigurationPath(args)) throw new FSError('EACCES', 'Shared configuration documents require administrator access');
            if (['transaction', 'walkTree', 'search'].includes(String(key))) throw new FSError('EACCES', 'Shared configuration traversal requires administrator access');
            const result = value.apply(target, args);
            return key === 'getChildren' ? Promise.resolve(result).then(nodes => nodes.filter((node: {name: string}) => node.name !== 'llm')) : result;
        };
    }});
    const driver = protect(fs.driver), meta = new Proxy(fs.meta, {get(target, key) {
        const value = Reflect.get(target, key, target); return value && typeof value === 'object' ? protect(value) : value;
    }});
    return new Proxy(fs, {get(target, key) {
        if (key === 'openFile') return (path: string) => {
            if (containsConfigurationPath(path)) throw new FSError('EACCES', 'Shared configuration documents require administrator access');
            return target.openFile(path);
        };
        if (key === 'driver') return driver;
        if (key === 'meta') return meta;
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
function containsConfigurationPath(value: unknown): boolean {
    if (typeof value === 'string') {
        if (!value.startsWith('/')) return false;
        const path = normalizeVirtualPath(value); return path === '/llm' || path.startsWith('/llm/');
    }
    if (Array.isArray(value)) return value.some(containsConfigurationPath);
    return !!value && typeof value === 'object' && Object.values(value).some(containsConfigurationPath);
}
