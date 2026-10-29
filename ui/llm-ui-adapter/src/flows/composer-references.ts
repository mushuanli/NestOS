import {createModuleLogger} from '@itookit/common';
import type {ResourceScope} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {resolveFlowArguments} from './flow-arguments';

const log = createModuleLogger('flow-composer-references');

/** Expand explicit text references once; referenced contents are never parsed as commands or more references. */
export async function expandComposerReferences(text: string, commands: ICommandBus, scope: ResourceScope,
    signal: AbortSignal, operationId: string): Promise<string> {
    const matches = [...text.matchAll(/(^|\s)(@(?:"(?:\\.|[^"\\])*"|(?:[a-z][a-z0-9-]*:)?\/[^\s]+))(?=\s|$)/g)];
    if (!matches.length) return text;
    const started = Date.now(), values = new Map<string, string>(); let result = '', cursor = 0;
    try {
        for (const match of matches) {
            signal.throwIfAborted();
            const reference = match[2];
            if (!values.has(reference)) {
                const resolved = await resolveFlowArguments(`value=${reference}`, [{name: 'value', type: 'string'}], commands, scope, signal);
                if (typeof resolved.value !== 'string') throw Object.assign(new Error('Referenced content must be text'), {code: 'FLOW_ARGUMENT_TEXT_REQUIRED'});
                values.set(reference, resolved.value);
            }
            signal.throwIfAborted();
            result += text.slice(cursor, match.index) + match[1] + values.get(reference); cursor = match.index! + match[0].length;
        }
        log.info('flow.composer.references', {operationId, stage: 'read', result: 'success', referenceCount: values.size, durationMs: Date.now() - started});
        return result + text.slice(cursor);
    } catch (error) {
        log.warn('flow.composer.references', {operationId, stage: 'read', result: 'failure', referenceCount: values.size,
            code: signal.aborted ? 'FLOW_INPUT_CANCELLED' : failureCode(error), durationMs: Date.now() - started});
        throw error;
    }
}

function failureCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'FLOW_COMPOSER_REFERENCE_FAILED';
}
