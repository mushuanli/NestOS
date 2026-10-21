import {expect, it} from 'vitest';
import {providerTestResult} from '../src/editors/provider-test-result';
import {t} from '@itookit/common';

it('shows operation, model, stage and actionable network advice while retaining the request ID', () => {
    const result = providerTestResult({success: false, message: 'Failed to fetch', code: 'NETWORK_ERROR', stage: 'transport',
        model: 'speech-model', operation: 'speech.synthesize', latency: 778, requestId: '53ff0de2-ccb6-4863-bb79-42a9de4b0828'});
    expect(result).toContain(t('provider.protocol.failed'));
    expect(result).toContain(t('model.capability.speechSynthesis'));
    expect(result).toContain('speech-model'); expect(result).toContain('778 ms');
    expect(result).toContain(t('provider.test.stage.transport')); expect(result).toContain('CORS');
    expect(result).toContain('53ff0de2-ccb6-4863-bb79-42a9de4b0828');
    expect(result).not.toContain('HTTP 200');
});

it('keeps HTTP and upstream business errors separate from network failures', () => {
    const result = providerTestResult({success: false, message: 'Request rejected', stage: 'response', statusCode: 403, remoteCode: 'ModelNotOpen', requestId: 'request'});
    expect(result).toContain('HTTP 403'); expect(result).toContain('ModelNotOpen');
    expect(result).toContain(t('provider.test.credentialsHint')); expect(result).not.toContain(t('provider.test.networkHint'));
});
