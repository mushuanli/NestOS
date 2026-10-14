import type { DispatchConfig, SerializableExpression } from '../../contracts';
import { assertFlowSchema } from '../schema-registry';
import { assertKey } from './value';
import { validateFields } from './input';

export function validateExpression(expression: SerializableExpression, depth = 0): void {
    if (!expression || depth > 30 || !['literal', 'path', 'not', 'and', 'or', 'eq', 'neq', 'in', 'exists', 'gt', 'gte', 'lt', 'lte'].includes(expression.kind)) {
        throw new Error('Invalid structured Flow expression');
    }
    const count = expression.args?.length ?? 0;
    const arity = { not: 1, exists: 1, in: 1, eq: 2, neq: 2, gt: 2, gte: 2, lt: 2, lte: 2 };
    if (expression.kind in arity && count !== arity[expression.kind as keyof typeof arity]) throw new Error('Invalid expression operand count');
    if (['and', 'or'].includes(expression.kind) && count === 0) throw new Error('Boolean expressions require operands');
    for (const part of expression.path ?? []) if (['__proto__', 'constructor', 'prototype'].includes(part)) throw new Error('Unsafe expression path');
    for (const child of expression.args ?? []) validateExpression(child, depth + 1);
}

export function validateDispatch(config: DispatchConfig, allowTemplates = false): void {
    if (!deferredNumber(config.maxRounds, allowTemplates) && (!Number.isSafeInteger(config.maxRounds) || config.maxRounds < 1 || config.maxRounds > 1000)) throw new Error('maxRounds must be between 1 and 1000');
    if (!['exclusive', 'multicast'].includes(config.mode)) throw new Error('Invalid dispatch mode');
    if (config.selectionOrder && !['missing-first', 'declared'].includes(config.selectionOrder)) throw new Error('Invalid selectionOrder');
    if (config.maxConcurrency !== undefined && !deferredNumber(config.maxConcurrency, allowTemplates)
        && (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1)) throw new Error('Invalid maxConcurrency');
    if (!Array.isArray(config.branches) || !config.branches.length) throw new Error('Dispatch branches are required');
    validateContext(config.context, config.requireNoHistory);
    if (config.invocationDefaults?.context) validateContext(config.invocationDefaults.context, config.requireNoHistory);
    validateContract(config.invocationDefaults?.outputContract);
    if (config.invocationDefaults?.prompt !== undefined && typeof config.invocationDefaults.prompt !== 'string') throw new Error('Prompt must be a string');
    if (config.join && (!['fail', 'partial'].includes(config.join.failure) || !/^[A-Za-z][\w.-]*@\d+$/.test(config.join.reducer))) throw new Error('Invalid join policy');
    if (config.join?.projection) validateExpression(config.join.projection);
    validateExpression(config.until);
    const keys = new Set<string>();
    for (const branch of config.branches) {
        assertKey(branch.key);
        if (keys.has(branch.key)) throw new Error(`Duplicate dispatch key: ${branch.key}`);
        keys.add(branch.key);
        validateBranch(config, branch);
    }
    if (config.revision) {
        validateFields(config.revision.fields);
        if (config.revision.invocation) {
            assertKey(config.revision.invocation.key);
            if (keys.has(config.revision.invocation.key)) throw new Error('Revision key conflicts with a review branch');
            validateBranch(config, config.revision.invocation);
        }
    }
}

function deferredNumber(value: unknown, allowed: boolean): boolean {
    return allowed && typeof value === 'string' && /^\$\{(?:params|param)\.([A-Za-z0-9_.-]+)\}$/.test(value.trim());
}

function validateBranch(config: DispatchConfig, branch: DispatchConfig['branches'][number]): void {
    if (!branch.target?.plugin || !branch.target.pluginVersion) throw new Error('Dispatch target requires a versioned plugin');
    validateContract(branch.outputContract);
    if (branch.prompt !== undefined && typeof branch.prompt !== 'string') throw new Error('Prompt must be a string');
    if (branch.context) validateContext(branch.context, config.requireNoHistory);
    if (!branch.input || typeof branch.input !== 'object' || Array.isArray(branch.input)) throw new Error('Branch input bindings are required');
    for (const [key, expression] of Object.entries(branch.input)) { assertKey(key); validateExpression(expression); }
    if (branch.outputFormat && !['value', 'json'].includes(branch.outputFormat)) throw new Error('Invalid outputFormat');
    for (const expression of [branch.when, branch.output, branch.validate]) if (expression) validateExpression(expression);
    if (branch.outputSchema !== undefined) assertFlowSchema(branch.outputSchema);
}

function validateContext(context: DispatchConfig['context'], requireNone?: boolean): void {
    if (!context || !['none', 'explicit'].includes(context.history)) throw new Error('Dispatch history must be none or explicit');
    if (requireNone && context.history !== 'none') throw new Error('Route requires history:none');
    if (context.history === 'none' && context.messages?.length) throw new Error('history:none cannot include messages');
    for (const message of context.messages ?? []) {
        if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error('Invalid explicit history message');
    }
}

function validateContract(contract: import('../../contracts').FlowOutputContract | undefined): void {
    if (!contract) return;
    if (contract.onInvalid && !['fail', 'repair'].includes(contract.onInvalid)) throw new Error('Invalid output failure policy');
    if (contract.retries !== undefined && (!Number.isInteger(contract.retries) || contract.retries < 0 || contract.retries > 3)) throw new Error('Output repair retries must be between 0 and 3');
    if (!['json', 'value'].includes(contract.format)) throw new Error('Invalid output contract format');
    if (contract.schema !== undefined) assertFlowSchema(contract.schema);
    for (const expression of [contract.select, contract.validate]) if (expression) validateExpression(expression);
}
