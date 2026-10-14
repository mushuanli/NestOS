import preset from './direct-agent.json';
import type { DirectAgentPolicy } from '@itookit/llm-session/contracts';

/** MindOS chooses the execution guidance and budget; Session only transmits them. */
export function createMindosDirectAgentPolicy(): DirectAgentPolicy { return structuredClone(preset); }
