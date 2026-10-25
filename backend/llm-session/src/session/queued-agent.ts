import {sha256HexSync} from '@itookit/llm-context';
import {isRootCallable, isTargetRef} from '@itookit/llm-flow/contracts';
import type {ExecutorConfig} from '../core/types';
import type {SessionInstruction} from '../contracts/instruction-queue';

type QueuedAgent = NonNullable<SessionInstruction['connectionBinding']>['agent'];
const FIELDS = ['id', 'name', 'type', 'exposure', 'icon', 'description', 'temperature', 'systemPrompt',
    'modelDefaults', 'agentVersion', 'execution', 'capabilityPolicy', 'memoryPolicy', 'defaultContextPolicy',
    'model', 'connectionId', 'stream', 'enableThinking', 'reasoningEffort', 'webSearchMode', 'constraints', 'target'];

/** Capture identity and policy, while model choice and actual conversation context remain separate. */
export function freezeQueuedAgent(identity: ExecutorConfig): NonNullable<QueuedAgent> {
    const config = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(identity).filter(([key]) => FIELDS.includes(key))))) as ExecutorConfig;
    const saved = {version: 1 as const, config, digest: sha256HexSync(canonical(config))};
    if (!isQueuedAgent(saved, identity.id)) throw invalid();
    return saved;
}

export function isQueuedAgent(value: unknown, id: string): value is NonNullable<QueuedAgent> {
    try {
        if (!record(value) || value.version !== 1 || !record(value.config)
            || Object.keys(value).some(key => !['version', 'config', 'digest'].includes(key))) return false;
        const config = value.config;
        return validIdentity(config, id) && validBehavior(config)
            && safe(config) && value.digest === sha256HexSync(canonical(config));
    } catch { return false; }
}

function validIdentity(config: Record<string, unknown>, id: string): boolean {
    return config.id === id && typeof config.name === 'string' && config.type === 'agent'
        && typeof config.agentVersion === 'string' && !!config.agentVersion && isRootCallable(config)
        && Object.keys(config).every(key => FIELDS.includes(key));
}

function validBehavior(config: Record<string, unknown>): boolean {
    const execution = config.execution, prompt = config.systemPrompt;
    if (!validPublishedTarget(config)) return false;
    if (execution !== undefined && (!record(execution) || execution.kind !== 'agent' || Object.keys(execution).length !== 1)) return false;
    return prompt === undefined || Array.isArray(prompt) && prompt.every(item => typeof item === 'string');
}
function validPublishedTarget(config: Record<string, unknown>): boolean {
    const target = config.target;
    return target === undefined || isTargetRef(target) && target.kind === 'agent' && target.id === config.id && target.version === config.agentVersion;
}

export function readQueuedAgent(value: QueuedAgent, id: string): ExecutorConfig | undefined {
    if (value === undefined) return;
    if (!isQueuedAgent(value, id)) throw invalid();
    return structuredClone(value.config);
}

function safe(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return typeof value !== 'number' || Number.isFinite(value);
    if (Array.isArray(value)) return value.every(safe);
    return Object.entries(value).every(([key, child]) => !/^(?:apiKey|accessToken|refreshToken|authorization|clientSecret|password|headers)$/i.test(key) && safe(child));
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function invalid(): Error { return Object.assign(new Error('Invalid admitted Agent identity'), {code: 'QUEUE_AGENT_IDENTITY_INVALID'}); }
