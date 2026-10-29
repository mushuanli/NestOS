import {readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import type {ToolPackageFlow as FlowDraft} from '@itookit/app-contracts/services';
import {packageError, type ToolPackageSource} from './manifest';

/** Only installed, fingerprinted package resources can contribute workflow definitions. */
export async function readPackageFlows(source: ToolPackageSource): Promise<FlowDraft[]> {
    const result: FlowDraft[] = [];
    for (const relative of source.manifest.flows ?? []) {
        const file = await realpath(path.join(source.root, relative));
        const inside = path.relative(source.root, file);
        if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw packageError('TOOL_PACKAGE_PATH_INVALID', 'Flow resource leaves its package');
        if ((await stat(file)).size > 1024 * 1024) throw packageError('TOOL_PACKAGE_FLOW_TOO_LARGE', 'Flow resource exceeds 1 MiB');
        let draft: FlowDraft;
        try {draft = JSON.parse(await readFile(file, 'utf8'));} catch {throw packageError('TOOL_PACKAGE_FLOW_INVALID', 'Flow resource contains invalid JSON');}
        if (!draft || typeof draft.id !== 'string' || typeof draft.name !== 'string' || !Array.isArray(draft.nodes) || !Array.isArray(draft.edges)
            || result.some(previous => previous.id === draft.id)) throw packageError('TOOL_PACKAGE_FLOW_INVALID', 'Flow resource has an invalid or duplicate identity');
        result.push({...draft, layout: draft.layout ?? {}});
    }
    return result;
}
