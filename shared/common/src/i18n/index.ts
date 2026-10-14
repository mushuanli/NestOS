// @file: common/i18n/index.ts
// Lightweight i18n — no runtime dependencies, tree-shakeable.
//
// Usage:
//   import { t, setLocale } from '@itookit/common';
//
//   t('skill.toast.saved')               // '已保存'
//   t('skill.toast.imported', { count: 3 }) // '已导入 3 个 Skill'
//   setLocale('en');                     // switch to English

import { zhCN } from './zh-CN';
import { en }   from './en';
import type { LocaleStrings } from './zh-CN';
export type { LocaleKey, LocaleStrings } from './zh-CN';

export type Locale = 'zh-CN' | 'en';

const LOCALES: Record<Locale, LocaleStrings> = { 'zh-CN': zhCN as LocaleStrings, en };

let _locale: Locale = 'zh-CN';

/** Set the active locale. Affects all subsequent t() calls. */
export function setLocale(locale: Locale): void {
    _locale = locale;
}

/** Known historical labels, for migrating persisted names without changing the active locale. */
export function translatedValues(key: import('./zh-CN').LocaleKey): readonly string[] {
    return [...new Set(Object.values(LOCALES).map(strings => strings[key]))];
}

/** Get the currently active locale. */
export function getLocale(): Locale {
    return _locale;
}

/**
 * Translate a key to the current locale's string.
 *
 * Fallback chain: current locale → zh-CN → key itself.
 *
 * @param key     A dot-namespaced key, e.g. 'skill.toast.saved'
 * @param params  Optional interpolation map; replaces `{param}` occurrences.
 *
 * @example
 *   t('skill.toast.imported', { count: 3 }) // '已导入 3 个 Skill'
 */
export function t(key: import('./zh-CN').LocaleKey, params?: Record<string, string | number>): string {
    const strings = LOCALES[_locale] ?? LOCALES['zh-CN'];
    let str: string = (strings as Record<string, string>)[key]
        ?? (LOCALES['zh-CN'] as Record<string, string>)[key]
        ?? key;

    if (params) {
        for (const [k, v] of Object.entries(params)) {
            str = str.replaceAll(`{${k}}`, String(v));
        }
    }

    return str;
}

// Re-export everything from sub-modules for a single import point
export * from './icons';
export * from './zh-CN';
