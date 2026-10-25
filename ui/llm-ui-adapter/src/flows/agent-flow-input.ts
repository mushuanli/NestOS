import type {FlowParameter, JsonValue} from '@itookit/llm-flow/contracts';
import type {AgentFlowDraftInput} from './agent-flow';

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
