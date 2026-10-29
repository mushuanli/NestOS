import type {LLMModel} from '@itookit/driver-llm/contracts';

// Exact model IDs and output constraints from the official Ark image-generation docs.
// https://docs.volcengine.com/docs/ark/seedream-4-0-5-0
// https://docs.volcengine.com/docs/ark/seedream-5-0-pro
export const volcengineImageModels: LLMModel[] = [
    {id: 'doubao-seedream-4-0-250828', name: 'Doubao Seedream 4.0', sizes: ['1K', '2K', '4K']},
    {id: 'doubao-seedream-4-5-251128', name: 'Doubao Seedream 4.5', sizes: ['2K', '4K']},
    {id: 'doubao-seedream-5-0-pro-260628', name: 'Doubao Seedream 5.0 Pro', sizes: ['1K', '1.5K', '2K']},
    {id: 'doubao-seedream-5-0-flash-260915', name: 'Doubao Seedream 5.0 Flash', sizes: ['1K', '1.5K', '2K']},
].map(({id, name, sizes}) => ({id, name, category: 'image', capabilitiesKnown: true,
    supportedOperations: ['image.generate'], operations: {'image.generate': {
        inputModalities: ['text'], outputModalities: ['image'], formats: ['png', 'jpeg'], sizes, maxOutputs: 1,
    }}}));
