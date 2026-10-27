// @file: apps/cli/src/schema.ts
// 工作流配置的 Zod 严格 schema：负责结构、类型、枚举、必填、未知字段拒绝与
// task kind 互斥。跨字段引用（agent/connection/task）与环检测仍由 config.ts 手写校验。

import { z } from 'zod/v4';

const ID = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'invalid id');
const DURATION = z.union([z.string(), z.number()]);

const modelSchema = z.strictObject({
    id: z.string(),
    name: z.string().optional(),
    tier: z.enum(['optimal', 'standard', 'fast']).optional(),
    context_window: z.number().optional(),
    max_output: z.number().optional(),
    supports_tools: z.boolean().optional(),
    supports_thinking: z.boolean().optional(),
});

const providerSchema = z.strictObject({
    id: ID,
    name: z.string().optional(),
    implementation: z.enum(['openai-compatible', 'anthropic', 'gemini', 'custom']),
    base_url: z.string().min(1),
    default_path: z.string().optional(),
    responses_path: z.string().optional(),
    api_key_env: z.string().min(1),
    models: z.array(modelSchema).min(1),
});

const connectionSchema = z.strictObject({
    id: ID,
    name: z.string().optional(),
    provider: z.string(),
    protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini-generate']).optional(),
    tiers: z.strictObject({
        optimal: z.string().optional(),
        standard: z.string().optional(),
        fast: z.string().optional(),
    }),
});

const responseFormatSchema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text') }),
    z.strictObject({ type: z.literal('json_object') }),
    z.strictObject({ type: z.literal('json_schema'), json_schema: z.strictObject({
        name: z.string().min(1), schema: z.unknown(), strict: z.boolean().optional(),
    }) }),
]);
const nodePortSchema = z.strictObject({ id: z.string().min(1), version: z.string().min(1).optional(), definition: z.unknown().optional() });
const nodePortSchemas = z.strictObject({ inputs: z.record(z.string(), nodePortSchema).optional(),
    outputs: z.record(z.string(), nodePortSchema).optional() });

const agentSchema = z.strictObject({
    response_format: responseFormatSchema.optional(),
    output_validation: z.strictObject({ on_invalid: z.enum(['fail', 'repair', 'continue']).optional(),
        retries: z.number().int().min(0).max(10).optional() }).optional(),
    memory_policy: z.strictObject({
        shared_memory: z.strictObject({ id: z.string().trim().min(1), incarnation: z.string().trim().min(1) }).optional(),
        namespace_id: z.string().trim().min(1),
        read_scopes: z.array(z.string().trim().min(1)),
        write_scopes: z.array(z.string().trim().min(1)),
        retrieval_limit: z.number().int().nonnegative().optional(),
        retention: z.strictObject({ max_entries_per_scope: z.number().int().positive().optional(),
            before: z.number().nonnegative().optional() }).optional(),
    }).optional(),
    id: ID,
    name: z.string().optional(),
    connection: z.string().min(1),
    model_tier: z.enum(['optimal', 'standard', 'fast']).optional(),
    model: z.string().optional(),
    system_prompt: z.string().optional(),
    tools: z.array(z.string()).optional(),
    max_exchanges: z.number().int().positive().optional(),
    temperature: z.number().min(0).optional(),
    max_tokens: z.number().int().positive().optional(),
    thinking: z.boolean().optional(),
    reasoning_effort: z.enum(['low', 'medium', 'xhigh']).optional(),
    web_search: z.boolean().optional(),
    stream: z.boolean().optional(),
    approval: z.enum(['none', 'external', 'all']).optional(),
});

type RouteConditionSchema = z.ZodTypeAny;
const routeConditionSchema: RouteConditionSchema = z.union([
    z.string(),
    z.lazy(() => z.strictObject({
        eq: z.unknown().optional(),
        neq: z.unknown().optional(),
        in: z.array(z.unknown()).optional(),
        exists: z.boolean().optional(),
        and: z.array(routeConditionSchema).optional(),
        or: z.array(routeConditionSchema).optional(),
        not: routeConditionSchema.optional(),
        path: z.array(z.string()).optional(),
    })),
]);

const routeRuleSchema = z.strictObject({
    when: routeConditionSchema,
    then: z.string().min(1),
});

const routeSchema = z.strictObject({
    mode: z.enum(['exclusive', 'multicast', 'fallback']).optional(),
    rules: z.array(routeRuleSchema).min(1),
    default: z.string().optional(),
});

const spawnEdgeSchema = z.strictObject({
    from: z.string(),
    to: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
});

const supervisorSchema = z.strictObject({
    workers: z.array(z.string()).min(1),
    max_rounds: z.number().int().positive().optional(),
});

const retrySchema = z.strictObject({
    max_attempts: z.number().int().positive(),
    backoff_ms: z.number().min(0).optional(),
});

const dependencySchema = z.union([
    z.string(),
    z.strictObject({
        task: z.string(),
        on_failure: z.enum(['fail', 'skip', 'continue']).optional(),
    }),
]);

type TaskSchema = z.ZodTypeAny;
const taskSchema: TaskSchema = z.lazy(() => z.strictObject({
    id: ID,
    kind: z.enum(['agent', 'route', 'spawn', 'supervisor', 'node']).optional(),
    node: z.strictObject({ plugin: z.string().min(1), pluginVersion: z.string().min(1), config: z.unknown(),
        capabilities: z.array(z.string()).optional(),
        outputPolicy: z.strictObject({ includeInRunOutput: z.boolean().optional(), publishToHistory: z.boolean().optional() }).optional(),
    }).optional(),
    agent: z.string().optional(),
    description: z.string().optional(),
    port_schemas: nodePortSchemas.optional(),
    delegation: z.strictObject({
        agent: ID, instruction: z.string().min(1).optional(),
        max_tasks: z.number().int().min(1).max(32).optional(),
        max_concurrency: z.number().int().min(1).max(32).optional(),
        failure_policy: z.enum(['fail-fast', 'continue']).optional(),
    }).optional(),
    route: routeSchema.optional(),
    max_iterations: z.number().int().positive().optional(),
    spawn: z.strictObject({
        tasks: z.array(taskSchema).min(1),
        edges: z.array(spawnEdgeSchema),
    }).optional(),
    compensate: z.string().optional(),
    supervisor: supervisorSchema.optional(),
    depends_on: z.array(dependencySchema).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    outputs: z.record(z.string(), z.enum(['text', 'json', 'file'])).optional(),
    workspace_access: z.enum(['read', 'write']).optional(),
    retry: retrySchema.optional(),
    timeout: DURATION.optional(),
    priority: z.number().int().min(0).optional(),
    budget: z.record(z.string(), z.number().positive()).optional(),
}).superRefine((task, ctx) => {
    const controlFields = (['route', 'spawn', 'supervisor', 'node'] as const).filter(field => task[field] !== undefined);
    if (controlFields.length > 1) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} cannot combine ${controlFields.join(' and ')}` });
    }
    if (controlFields.length === 1 && task.kind && task.kind !== controlFields[0]) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind ${task.kind} conflicts with ${controlFields[0]} field` });
    }
    if (task.kind === 'agent' && controlFields.length) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind agent conflicts with ${controlFields.join(' and ')}` });
    }
    const inferredKind = task.kind ?? controlFields[0] ?? 'agent';
    if (task.delegation && inferredKind !== 'agent') {
        ctx.addIssue({ code: 'custom', message: 'delegation requires an agent task' });
    }
    if (inferredKind !== 'agent' && task[inferredKind] === undefined) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind ${inferredKind} requires ${inferredKind}` });
    }
    if ((inferredKind === 'agent' || inferredKind === 'supervisor') && !task.agent) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind ${inferredKind} requires agent` });
    }
    if (inferredKind === 'agent' && !task.description) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind agent requires description` });
    }
    if (inferredKind === 'route' && task.agent !== undefined) {
        ctx.addIssue({ code: 'custom', message: `task ${task.id} kind route cannot define agent` });
    }
    if (task.spawn) {
        for (const value of task.spawn.tasks) {
            const child = value as Record<string, unknown>;
            if (child.route !== undefined || child.spawn !== undefined || child.supervisor !== undefined
                || (child.kind !== undefined && child.kind !== 'agent')) {
                ctx.addIssue({ code: 'custom', message: `task ${task.id} spawn currently supports agent children only` });
            }
        }
    }
}));

export const workflowSchema = z.strictObject({
    version: z.literal(1),
    name: z.string().min(1),
    goal: z.string().min(1),
    workspace: z.strictObject({
        root: z.string().optional(),
        state_dir: z.string().optional(),
    }).optional(),
    providers: z.array(providerSchema).default([]),
    connections: z.array(connectionSchema).default([]),
    agents: z.array(agentSchema).default([]),
    tasks: z.array(taskSchema).min(1),
    result: z.strictObject({
        task: z.string(),
        output: z.string(),
    }),
    runtime: z.strictObject({
        max_concurrency: z.number().int().positive().optional(),
        max_duration: DURATION.optional(),
        workspace: z.strictObject({
            mode: z.enum(['shared', 'read-only', 'worktree']),
            base: z.string().optional(),
            merge: z.enum(['manual', 'auto-if-clean', 'discard']).optional(),
            cleanup: z.enum(['on-success', 'always', 'keep']).optional(),
        }).optional(),
    }).optional(),
    sandbox: z.strictObject({
        mode: z.enum(['native', 'oci']).optional(),
        engine: z.enum(['auto', 'podman', 'docker']).optional(),
        image: z.string().optional(),
        network: z.enum(['none', 'host']).optional(),
        limits: z.strictObject({
            cpus: z.number().optional(),
            memory: z.string().optional(),
            pids: z.number().optional(),
        }).optional(),
    }).optional(),
});
