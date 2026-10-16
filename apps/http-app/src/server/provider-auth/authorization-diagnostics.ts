import type { AuditPort } from '../audit-log';
import { OpenAIAuthorizationError } from './openai-oidc';

export type AuthorizationStage = 'client.validate' | 'token.exchange' | 'tokens.validate' | 'identity.verify'
    | 'account.validate' | 'credentials.save';

const validationCodes: Record<string, string> = {
    'client.validate': 'CLIENT_REGISTRATION_INVALID', 'tokens.validate': 'TOKEN_RESPONSE_INVALID',
    'identity.verify': 'IDENTITY_VALIDATION_FAILED', 'account.validate': 'ACCOUNT_MISMATCH',
    'credentials.save': 'CREDENTIAL_STORAGE_FAILED',
};
const identityCodes = new Map([
    ['Invalid OpenAI identity token', 'IDENTITY_TOKEN_INVALID'],
    ['Unsupported OpenAI signing algorithm', 'SIGNING_ALGORITHM_UNSUPPORTED'],
    ['OpenAI identity signature verification failed', 'IDENTITY_SIGNATURE_INVALID'],
    ['OpenAI identity claims verification failed', 'IDENTITY_CLAIMS_INVALID'],
    ['Sign-in cancelled', 'AUTHORIZATION_CANCELLED'],
]);

/** Only controlled codes and metadata reach audit logs; never serialize the original error. */
export function reportAuthorizationFailure(audit: Pick<AuditPort, 'write'> | undefined, operation: AuthorizationStage,
    error: unknown, startedAt: number): void {
    const remote = error instanceof OpenAIAuthorizationError ? error : undefined;
    const identity = error instanceof Error ? identityCodes.get(error.message) : undefined;
    audit?.write({ event: 'provider.authorization.failed', operation, durationMs: Date.now() - startedAt,
        code: remote?.code ?? identity ?? validationCodes[operation] ?? 'AUTHORIZATION_FAILED',
        ...(remote?.status !== undefined ? { status: remote.status } : {}),
        ...(remote?.requestId ? { providerRequestId: remote.requestId } : {}) });
}
