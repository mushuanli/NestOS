import type {Artifact} from '@itookit/llm-flow/contracts';

/** Host resolves immutable artifact identities within the actual calling Session. */
export type ArtifactLoader = (sessionId: string, artifactId: string) => Promise<Artifact | null>;
