import type { ApplicationClient } from './application-client';
import type { FlowDraft } from '@itookit/llm-flow/contracts';

export interface HostedApplicationClient extends ApplicationClient {
    flowLibrary: FlowDraft[];
    fileTemplates: Readonly<Record<string, string>>;
}
