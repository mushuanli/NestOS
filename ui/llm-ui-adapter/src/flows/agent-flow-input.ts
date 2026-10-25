import {assertFlowCallSignature, flowCallValues, type FlowParameter, type FlowRevision, type JsonValue} from '@itookit/llm-flow/contracts';
import type {AgentFlowDraftInput} from './agent-flow';
import {t} from '@itookit/common';

/** Composer data only fills fields that explicitly declare its source. */
export function agentFlowInput(parameters: FlowParameter[], draft?: AgentFlowDraftInput, defaults?: Readonly<Record<string, unknown>>): {
    parameters: FlowParameter[];
    initialFiles: Readonly<Record<string, readonly File[]>>;
} {
    const initialFiles: Record<string, readonly File[]> = {};
    const attachmentFields = parameters.filter(field => field.inputSource === 'composer.attachments');
    const fields = parameters.map(parameter => {
        const field = {...parameter, ...(Object.hasOwn(defaults ?? {}, parameter.name) ? {default: defaults![parameter.name] as JsonValue} : {})};
        if (draft?.files.length && attachmentFields.length === 1 && field.inputSource === 'composer.attachments') initialFiles[field.name] = [...draft.files];
        return draft?.text && field.inputSource === 'composer.text' ? {...field, default: draft.text} : field;
    });
    return {parameters: fields, initialFiles};
}

/** Restore confirmed parameters before presenting a form; only a changed composer replaces its declared text field. */
export function confirmedFlowInput(flow: Pick<FlowRevision, 'id' | 'revision' | 'digest' | 'parameters'>,
    draft?: AgentFlowDraftInput, defaults?: Readonly<Record<string, unknown>>): ReturnType<typeof agentFlowInput> {
    const prepared = agentFlowInput(flow.parameters ?? [], draft, defaults), input = draft?.input;
    if (!input) return prepared;
    assertFlowCallSignature(flow, {...input.signature, id: input.signature.id as FlowRevision['id']});
    const {values} = flowCallValues([], {kind: 'arguments', value: parseDraft(input.json)});
    const changed = input.composerText !== undefined && input.composerText !== draft.text;
    return {...prepared, parameters: prepared.parameters.map(field => changed && field.inputSource === 'composer.text'
        ? field : Object.hasOwn(values, field.name) ? {...field, default: values[field.name]} : field)};
}

function parseDraft(json: string): JsonValue {
    try {return JSON.parse(json);}
    catch {throw Object.assign(new Error(t('callable.input.invalidArguments')), {code: 'FLOW_INPUT_JSON_REQUIRED'});}
}
