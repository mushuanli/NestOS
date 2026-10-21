import {t} from '@itookit/common';
import type {ConnectionTestResult} from '@itookit/driver-llm/contracts';

/** Render business status and actionable diagnostics consistently for every probe. */
export function providerTestResult(result: ConnectionTestResult): string {
    const operation = result.operation === 'image.generate' ? t('model.capability.imageGeneration')
        : result.operation === 'speech.synthesize' ? t('model.capability.speechSynthesis') : t('provider.test.chatOperation');
    return [t(result.success ? 'provider.protocol.verified' : 'provider.protocol.failed'), result.message,
        operation, result.model && t('provider.test.model', {model: result.model}),
        result.stage && t(`provider.test.stage.${result.stage}`), result.statusCode !== undefined && `HTTP ${result.statusCode}`,
        result.code, result.transportCode, result.remoteCode, result.latency !== undefined && `${result.latency} ms`,
        result.requestId, !result.success && failureHint(result)].filter(value => value !== undefined && value !== false && value !== '').join(' · ');
}

function failureHint(result: ConnectionTestResult): string | undefined {
    if (result.code === 'NETWORK_ERROR') return t('provider.test.networkHint');
    if (result.code === 'TIMEOUT') return t('provider.test.timeoutHint');
    if (result.statusCode === 401 || result.statusCode === 403) return t('provider.test.credentialsHint');
    if (result.statusCode === 404) return t('provider.test.endpointHint');
    if (result.statusCode === 429) return t('provider.test.rateLimitHint');
    if (result.statusCode !== undefined && result.statusCode >= 500) return t('provider.test.serverHint');
}
