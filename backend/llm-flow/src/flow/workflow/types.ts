// @file: llm-flow/src/flow/workflow/types.ts
// 工作流 DSL 类型：声明式多 Agent 图（agent/route/spawn/supervisor + 控制流）。
// 字段保持 YAML 风格（snake_case），与 apps/cli 的配置直接兼容。

import type { DagEdgeDefinition, DagNodeDefinition } from '../../contracts';
import type { RouteCondition } from './route-expression';

export type { RouteCondition } from './route-expression';

export type DependencyRef = string | { task: string; on_failure?: 'fail' | 'skip' | 'continue' };

export interface RouteRule {
    when: RouteCondition;
    then: string;
}

export interface RouteConfig {
    /** exclusive=命中即停，multicast=激活所有命中分支，fallback=排他+默认兜底。 */
    mode?: 'exclusive' | 'multicast' | 'fallback';
    rules: RouteRule[];
    default?: string;
}

export interface SpawnEdge {
    from: string;
    to: string;
    input?: string;
    output?: string;
}

export interface SpawnConfig {
    /** 运行期动态派发的任务（编译为 agent 节点）。 */
    tasks: WorkflowTaskSpec[];
    edges: SpawnEdge[];
}

export interface SupervisorConfig {
    workers: string[];
    max_rounds?: number;
}

/** 工作流中的一个任务。`kind` 缺省时按 route/spawn/supervisor 字段推断。 */
export interface WorkflowTaskSpec {
    id: string;
    kind?: 'agent' | 'route' | 'spawn' | 'supervisor' | 'node';
    /** Versioned plugin node, including input, structured route and aggregate. */
    node?: Pick<DagNodeDefinition, 'plugin' | 'pluginVersion' | 'config' | 'capabilities' | 'outputPolicy'>;
    /** 执行本任务的 agent id（spawn 子任务与 supervisor 需要）。 */
    agent?: string;
    description?: string;
    depends_on?: DependencyRef[];
    inputs?: Record<string, unknown>;
    route?: RouteConfig;
    spawn?: SpawnConfig;
    supervisor?: SupervisorConfig;
    /** 循环体节点声明的迭代上限（环上节点共享）。 */
    max_iterations?: number;
    /** 失败时执行的补偿任务 id（Saga 回滚）。 */
    compensate?: string;
    retry?: { max_attempts: number; backoff_ms?: number };
    priority?: number;
    budget?: Record<string, number>;
    /** 入口透传的额外字段（agent 引用、outputs、workspace_access 等），由 agentFactory 消费。 */
    [extra: string]: unknown;
}

export interface WorkflowGraph {
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
}

/** 把单个任务编译成 DAG 节点；role 让入口注入 supervisor/worker 的差异化编译。 */
export type AgentNodeFactory = (
    task: WorkflowTaskSpec,
    role?: 'agent' | 'supervisor' | 'worker',
) => DagNodeDefinition;

/** 解析 `${tasks.<id>.outputs.<name>}` 模板引用。 */
export type OutputReferenceResolver = (value: unknown) => { taskId: string; output: string } | undefined;
