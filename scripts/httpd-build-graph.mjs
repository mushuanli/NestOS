import { writeFileSync } from 'node:fs';

/** Used only by isolated release builds; ordinary Vite builds create no cache metadata. */
export function httpBuildGraph() {
    const destination = process.env.NESTOS_HTTPD_BUILD_GRAPH;
    if (!destination) return;
    return { name: 'nestos-http-build-inputs', generateBundle() {
        writeFileSync(destination, JSON.stringify([...new Set([...this.getModuleIds(), ...this.getWatchFiles()])]));
    } };
}
