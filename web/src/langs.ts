export const AVAILABLE_LANGS = ['en', 'ko', 'es', 'pt', 'fr'] as const
export type SupertonicLang = typeof AVAILABLE_LANGS[number]
