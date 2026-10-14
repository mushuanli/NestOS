/** Business identities are independent of sidebar paths and URL encodings. */
export type ProjectTarget =
    | { kind: 'project'; projectId: string }
    | { kind: 'group'; folder: string | null }
    | { kind: 'session'; sessionId: string }
    | { kind: 'file'; projectId: string; path: string };
