// @file: llm-flow/src/flow/workflow/route-expression.ts
// 工作流 DSL 的路由条件编译：把声明式 RouteCondition 编译成可序列化表达式。
// 供 apps/cli 与未来入口复用，消除 CLI 中重复的表达式编译。

import type { JsonValue, SerializableExpression } from '../../contracts';

/**
 * 路由条件：字符串为相等匹配；对象支持 eq/neq/in/exists/and/or/not 组合，
 * 并可带 `path` 在 input 内部取嵌套字段后再比较。
 */
export type RouteCondition =
    | string
    | {
        eq?: unknown;
        neq?: unknown;
        in?: unknown[];
        exists?: boolean;
        gt?: unknown;
        gte?: unknown;
        lt?: unknown;
        lte?: unknown;
        and?: RouteCondition[];
        or?: RouteCondition[];
        not?: RouteCondition;
        /** 相对 route 节点 input 的嵌套字段路径（如 ['kind'] 表示 input.kind）。 */
        path?: string[];
    };

/** 把声明式路由条件编译成以 route 节点 input 为基准的可序列化表达式。 */
export function compileRouteCondition(condition: RouteCondition): SerializableExpression {
    const target = (): SerializableExpression => ({ kind: 'path', path: ['input'] });
    const field = (path?: string[]): SerializableExpression => ({
        kind: 'path',
        path: path?.length ? ['input', ...path] : ['input'],
    });

    if (typeof condition === 'string') {
        return { kind: 'eq', args: [target(), { kind: 'literal', value: condition }] };
    }
    const selector = () => field(condition.path);
    if (condition.eq !== undefined) return { kind: 'eq', args: [selector(), { kind: 'literal', value: condition.eq as JsonValue }] };
    if (condition.neq !== undefined) return { kind: 'neq', args: [selector(), { kind: 'literal', value: condition.neq as JsonValue }] };
    if (condition.in !== undefined) return { kind: 'in', args: [selector()], value: condition.in as JsonValue };
    if (condition.gt !== undefined) return { kind: 'gt', args: [selector(), { kind: 'literal', value: condition.gt as JsonValue }] };
    if (condition.gte !== undefined) return { kind: 'gte', args: [selector(), { kind: 'literal', value: condition.gte as JsonValue }] };
    if (condition.lt !== undefined) return { kind: 'lt', args: [selector(), { kind: 'literal', value: condition.lt as JsonValue }] };
    if (condition.lte !== undefined) return { kind: 'lte', args: [selector(), { kind: 'literal', value: condition.lte as JsonValue }] };
    if (condition.exists !== undefined) {
        const exists: SerializableExpression = { kind: 'exists', args: [selector()] };
        return condition.exists ? exists : { kind: 'not', args: [exists] };
    }
    if (condition.and !== undefined) return { kind: 'and', args: condition.and.map(compileRouteCondition) };
    if (condition.or !== undefined) return { kind: 'or', args: condition.or.map(compileRouteCondition) };
    if (condition.not !== undefined) return { kind: 'not', args: [compileRouteCondition(condition.not)] };
    throw new Error('Route condition has no operator');
}
