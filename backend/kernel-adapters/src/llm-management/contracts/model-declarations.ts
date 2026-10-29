import type {LLMModel} from '@itookit/driver-llm/contracts';

/** Complete an exact ID from the host's declared catalog; never infer from display names. */
export function completeModelDeclaration(model: LLMModel, declared?: LLMModel): LLMModel {
    if (!declared || declared.id !== model.id) return model;
    const operations = model.operations ?? declared.operations;
    return {...model, operations, supportedOperations: model.supportedOperations ?? declared.supportedOperations,
        category: model.operations ? model.category : declared.operations ? declared.category : model.category ?? declared.category,
        capabilitiesKnown: operations && Object.keys(operations).length ? true : model.capabilitiesKnown,
        reasoning: model.reasoning ?? declared.reasoning, reasoningByProtocol: model.reasoningByProtocol ?? declared.reasoningByProtocol};
}
