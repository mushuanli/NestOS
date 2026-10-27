import preset from './direct-agent.json';
import type { DirectAgentPolicy } from '@itookit/llm-session/contracts';

/** NestOS chooses the execution guidance and budget; Session only transmits them. */
export function createNestosDirectAgentPolicy(): DirectAgentPolicy { return structuredClone(preset); }
