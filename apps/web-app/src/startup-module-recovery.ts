import {createModuleLogger, randomUUID} from '@itookit/common';

const log = createModuleLogger('startup-modules');
export const isModuleLoadFailure = (message: string): boolean =>
    /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS/i.test(message);

/** Safari may retain a failed modulepreload across document reloads. */
export function startupModuleRecovery(options: {reload?: () => void; fetcher?: typeof fetch} = {}) {
    const failed = new Set<string>();
    const remember = (event: Event) => {
        const target = event.target;
        if (target instanceof HTMLLinkElement && ['modulepreload', 'stylesheet'].includes(target.rel)) add(target.href);
        if (target instanceof HTMLScriptElement && target.type === 'module') add(target.src);
    };
    const add = (value: string) => {const asset = moduleAsset(value); if (asset && failed.size < 32) failed.add(asset);};
    window.addEventListener('error', remember, true);
    return {
        dispose: () => window.removeEventListener('error', remember, true),
        async reload(repair: boolean): Promise<void> {
            if (repair) {
                for (const node of document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>('link[rel=modulepreload], script[type=module][src]'))
                    add(node instanceof HTMLLinkElement ? node.href : node.src);
                await repairModules([...failed], options.fetcher ?? globalThis.fetch);
            }
            (options.reload ?? (() => location.reload()))();
        },
    };
}
function moduleAsset(value: string): string | undefined {
    try {
        const url = new URL(value, location.href);
        return url.origin === location.origin && /^\/assets\/[\w.-]+-[\w-]{8,}\.(?:js|css)$/.test(url.pathname) ? url.pathname : undefined;
    } catch {return undefined;}
}
async function repairModules(assets: string[], fetcher: typeof fetch): Promise<void> {
    const operationId = randomUUID(), started = performance.now(); let asset: string | undefined, missing = 0;
    const deadline = AbortSignal.timeout(15000);
    try {
        for (asset of assets) {
            const response = await fetcher(asset, {cache: 'reload', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)])});
            if (response.status === 404) {await response.body?.cancel(); missing++; continue;}
            if (!response.ok) {await response.body?.cancel(); throw Object.assign(new Error('Module recovery request failed'), {code: `HTTP_${response.status}`});}
            await response.arrayBuffer();
        }
        log.info('startup.modules.repair', {operationId, stage: 'fetch', result: missing ? 'version-changed' : 'success', count: assets.length, missing,
            durationMs: Math.round(performance.now() - started)});
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        log.warn('startup.modules.repair', {operationId, stage: 'fetch', result: 'failure', asset,
            code: typeof code === 'string' && /^HTTP_\d{3}$/.test(code) ? code : 'MODULE_RECOVERY_FAILED', durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}
