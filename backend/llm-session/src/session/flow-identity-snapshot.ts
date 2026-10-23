import type { ExecutorConfig } from '../core/types';
import type { LLMSkill } from '../contracts/agent';
import type { SystemPromptDefinition } from '@itookit/llm-tasks/contracts';
import type { FlowIdentityResolver } from './flow-node-binder';
import type { FlowIdentitySnapshot } from '../contracts/flow-run-plan';

/** Memoize source reads for one admission, including missing optional resources. */
export function captureFlowIdentities(live: FlowIdentityResolver, sessionId: string) {
    const agents = memo<string, ExecutorConfig>(id => live.resolveExact(id));
    const skills = memo<string, LLMSkill | null>(async id => (await live.getSkills([id], sessionId)).find(skill => skill.id === id) ?? null);
    const prompts = memo<string, SystemPromptDefinition | null>(id => live.getSystemPrompt(id));
    const mcp = memo<string, string[]>(id => {
        if (!live.getMCPToolIds) throw new Error('MCP profile resolution is unavailable');
        return live.getMCPToolIds([id], sessionId);
    });
    return {
        resolver: { resolveExact: agents.read, getSystemPrompt: prompts.read,
            ...(live.resolveHarnessConnection ? { resolveHarnessConnection: live.resolveHarnessConnection.bind(live) } : {}),
            getSkills: async (ids: string[]) => (await Promise.all(ids.map(id => skills.read(id)))).filter((skill): skill is LLMSkill => !!skill),
            getMCPToolIds: async (ids: string[]) => [...new Set((await Promise.all(ids.map(id => mcp.read(id)))).flat())] } satisfies FlowIdentityResolver,
        snapshot: (): FlowIdentitySnapshot => ({ agents: agents.snapshot(), skills: skills.snapshot(), prompts: prompts.snapshot(), mcp: mcp.snapshot() }),
    };
}

function memo<K, V>(read: (key: K) => Promise<V>) {
    const pending = new Map<K, Promise<V>>(), values = new Map<K, V>();
    return { read(key: K): Promise<V> {
        if (!pending.has(key)) pending.set(key, read(key).then(value => { values.set(key, structuredClone(value)); return value; }));
        return pending.get(key)!.then(value => structuredClone(value));
    }, snapshot: (): Array<[K, V]> => structuredClone([...values]) };
}

/** Runtime binding can consume admitted definitions but cannot follow later source edits. */
export function frozenFlowIdentities(snapshot: FlowIdentitySnapshot, dynamic?: FlowIdentityResolver): FlowIdentityResolver {
    const read = async <T>(entries: Array<[string, T]>, id: string, admit?: () => Promise<T>): Promise<T> => {
        const found = entries.find(([key]) => key === id);
        if (!found) {
            if (admit) return structuredClone(await admit());
            throw new Error(`Flow identity was not admitted: ${id}`);
        }
        return structuredClone(found[1]);
    };
    return { resolveExact: id => read(snapshot.agents, id, dynamic && (() => dynamic.resolveExact(id))),
        ...(dynamic?.resolveHarnessConnection ? { resolveHarnessConnection: dynamic.resolveHarnessConnection.bind(dynamic) } : {}),
        getSystemPrompt: id => read(snapshot.prompts, id, dynamic && (() => dynamic.getSystemPrompt(id))),
        getSkills: async (ids, sessionId) => (await Promise.all(ids.map(id => read(snapshot.skills, id, dynamic &&
            (async () => (await dynamic.getSkills([id], sessionId)).find(skill => skill.id === id) ?? null))))).filter((skill): skill is LLMSkill => !!skill),
        getMCPToolIds: async (ids, sessionId) => [...new Set((await Promise.all(ids.map(id => read(snapshot.mcp, id,
            dynamic?.getMCPToolIds && (() => dynamic.getMCPToolIds!([id], sessionId)))))).flat())] };
}
