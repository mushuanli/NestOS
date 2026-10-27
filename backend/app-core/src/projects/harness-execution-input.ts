import type { JsonValue } from '@itookit/durable-kernel';
import type { HarnessEvent } from '@itookit/nestos-node-driver';
import { executionError } from './harness-execution-journal';

interface Question { id: string; question: string; multiSelect?: boolean }
type RecordValue = Record<string, JsonValue>;
function object(value: unknown): RecordValue | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function questions(request: HarnessEvent['message']): Question[] {
    const values = request.params?.questions;
    if (!Array.isArray(values) || !values.length || values.some(value => !value || typeof value.id !== 'string' || !value.id
        || typeof value.question !== 'string' || !value.question.trim()
        || value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') || new Set(values.map(value => value.id)).size !== values.length)
        throw executionError('NATIVE_QUESTIONS_INVALID');
    return values as Question[];
}
function answer(values: unknown, question: Question): { answers: string[] } {
    if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string' || !value.trim())
        || !question.multiSelect && values.length !== 1) throw executionError('NATIVE_INPUT_INVALID');
    return { answers: values as string[] };
}
function validateNative(value: RecordValue, items: Question[]): RecordValue {
    const answers = object(value.answers);
    if (!answers || Object.keys(answers).length !== items.length) throw executionError('NATIVE_INPUT_INVALID');
    for (const question of items) answer(object(answers[question.id])?.answers, question);
    return value;
}
function platformValue(value: JsonValue | undefined, question: Question): { answers: string[] } {
    if (typeof value !== 'string') throw executionError('NATIVE_INPUT_INVALID');
    let values: unknown = [value];
    if (question.multiSelect) {
        try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) values = parsed; }
        catch { /* A free-form multi-choice answer remains one explicit answer. */ }
    }
    return answer(values, question);
}
function platformAnswers(answers: RecordValue, items: Question[]): RecordValue {
    const keys = items.map((question, index) => items.some((other, position) => position !== index && other.question === question.question)
        ? `${index + 1}. ${question.question}` : question.question);
    if (new Set(keys).size !== keys.length || Object.keys(answers).length !== keys.length
        || keys.some(key => !Object.hasOwn(answers, key))) throw executionError('NATIVE_INPUT_INVALID');
    return { answers: Object.fromEntries(items.map((question, index) => [question.id, platformValue(answers[keys[index]], question)])) };
}
/** Translate the platform's string answer transport; native structured answers retain their original object. */
export function nativeInputResponse(request: HarnessEvent['message'], response: JsonValue): RecordValue {
    const items = questions(request);
    if (typeof response !== 'string') {
        const value = object(response);
        if (!value) throw executionError('NATIVE_INPUT_INVALID');
        return validateNative(value, items);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(response); } catch { /* Plain text is valid only for one question. */ }
    const value = object(parsed), answers = object(value?.answers);
    if (value && answers) {
        if (items.every(question => object(answers[question.id]))) return validateNative(value, items);
        return platformAnswers(answers, items);
    }
    if (items.length !== 1) throw executionError('NATIVE_INPUT_INVALID');
    return { answers: { [items[0].id]: platformValue(response, items[0]) } };
}
