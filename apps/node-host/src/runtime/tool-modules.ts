import {createTools as createImageTools} from '@itookit/image-tools';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { buildTool, type Tool } from '@itookit/tools';
import { z } from 'zod/v4';

export interface ToolModuleAPI { buildTool: typeof buildTool; z: typeof z; }

/** Only trusted host configuration selects executable extension modules. */
export async function loadNodeToolModules(value = process.env.MINDOS_TOOL_MODULES): Promise<Tool[]> {
    if (!value) return [];
    const paths: unknown = JSON.parse(value);
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
        throw new Error('MINDOS_TOOL_MODULES must be a JSON array of absolute module paths');
    }
    const tools: Tool[] = [], names = new Set<string>();
    for (const path of paths) {
        const module = await import(/* @vite-ignore */ pathToFileURL(path).href);
        if (typeof module.createTools !== 'function') throw new Error('Tool module must export createTools');
        const additions = await module.createTools({ buildTool, z } satisfies ToolModuleAPI);
        if (!Array.isArray(additions)) throw new Error('Tool module must return a tool array');
        for (const tool of additions) {
            if (!tool?.name || names.has(tool.name) || typeof tool.call !== 'function') throw new Error('Invalid or duplicate external tool');
            names.add(tool.name); tools.push(tool);
        }
    }
    return tools;
}

export function createStandardNodeTools(): Tool[] {return createImageTools();}
