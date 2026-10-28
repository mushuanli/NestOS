import { label } from './view';
export function twinError(code: string, detail = ''): string {
    if (!code) return '';
    const keys: Record<string, string> = {
        TWIN_EXTRACTION_FAILED: 'extractionFailed', TWIN_EXTRACTION_TIMEOUT: 'extractionTimeout',
        TWIN_EXTRACTION_CANCELLED: 'extractionCancelled', TWIN_INVALID_EXTRACTION: 'extractionInvalid',
        TWIN_EXTRACTION_TRUNCATED: 'extractionTruncated', TWIN_BUDGET_EXHAUSTED: 'budgetExhausted',
        TWIN_SCAN_BUDGET_EXHAUSTED: 'budgetExhausted', TWIN_MONTHLY_BUDGET_EXHAUSTED: 'monthlyBudgetExhausted',
    };
    const title = keys[code] ? label(keys[code]) : code;
    return [title, detail && detail !== code ? detail : ''].filter(Boolean).join(' · ');
}
