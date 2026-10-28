import type {InputPlugin as SharedInputPlugin, InputPluginContext as SharedInputPluginContext} from '@itookit/llm-ui';

/** NestOS supplies its executor selection through the shared editing context. */
export interface InputPluginContext extends SharedInputPluginContext {getAgentId(): string;}
export type InputPlugin = SharedInputPlugin<InputPluginContext, string>;
