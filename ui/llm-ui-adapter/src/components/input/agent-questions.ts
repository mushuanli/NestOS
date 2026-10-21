import { t } from '@itookit/common';
import type { Choice, InputField, InteractionResponse } from '@itookit/llm-ui';
import type { JsonValue } from '@itookit/durable-kernel/contracts';

/** Invalid question sets retain the existing plain-text fallback as a whole. */
export function agentQuestionFields(value: JsonValue | undefined): InputField[] {
    if (!Array.isArray(value) || !value.length) return [];
    const fields = value.map(questionField);
    return fields.every((field): field is InputField => field !== undefined) ? fields : [];
}

function questionField(value: JsonValue, index: number): InputField | undefined {
    const question = object(value);
    if (typeof question?.question !== 'string' || !question.question.trim()) return;
    const base = { id: `question-${index}`, label: question.question, required: true };
    if (question.options == null) return { ...base, kind: 'text' };
    const choices = questionChoices(question.options);
    if (!choices) return;
    const other = t('harness.otherAnswer');
    return question.multiSelect === true ? { ...base, kind: 'multi-choice', choices, min: 1, other }
        : { ...base, kind: 'single-choice', choices, other };
}

function questionChoices(value: JsonValue): Choice[] | undefined {
    if (!Array.isArray(value) || !value.length) return;
    const choices = value.map(questionChoice);
    return choices.every((choice): choice is Choice => choice !== undefined) ? choices : undefined;
}

function questionChoice(value: JsonValue): Choice | undefined {
    if (typeof value === 'string' && value.trim()) return { id: value, label: value };
    const option = object(value);
    if (typeof option?.label !== 'string' || !option.label.trim()) return;
    return { id: option.label, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) };
}

function object(value: JsonValue): Record<string, JsonValue> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** The Agent's human-input contract remains a string; retain every answer in JSON. */
export function agentQuestionAnswer(fields: readonly InputField[], response: InteractionResponse): string {
    if (response.kind !== 'input') throw new Error('Expected an input response');
    const answers = fields.map((field, index) => {
        const key = fields.some((other, position) => position !== index && other.label === field.label)
            ? `${index + 1}. ${field.label}` : field.label;
        const value = response.values[field.id];
        return [key, typeof value === 'string' ? value : JSON.stringify(value ?? [])];
    });
    return JSON.stringify({ answers: Object.fromEntries(answers) });
}
