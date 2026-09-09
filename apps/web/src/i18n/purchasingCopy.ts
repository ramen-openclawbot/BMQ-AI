import { formatText } from "@/i18n/format";
import { useLanguage } from '@/contexts/LanguageContext';

// Each call site selects an explicit UI key; business strings are never input.
export function usePurchasingCopy<T extends Record<string, string>>(copy: { vi: T; en: T }): T {
  const { language } = useLanguage();
  return copy[language];
}

// Persistent UI status keeps its key so an open dialog can react to language changes.
// Plain strings here are backend errors and are displayed verbatim.
export type PurchasingUiMessage<K extends string> = string | {
  copyKey: K;
  values?: Record<string, string | number>;
};

export function renderPurchasingMessage<K extends string>(
  copy: Record<K, string>, message: PurchasingUiMessage<K> | null | undefined,
): string | null | undefined {
  if (message == null) return null;
  if (typeof message === 'string') return message;
  return formatText(copy[message.copyKey], message.values || {});
}

// Explicit provenance survives throw/catch; backend text is never used to infer a key.
export class PurchasingLocalError<K extends string> extends Error {
  constructor(readonly uiMessage: Exclude<PurchasingUiMessage<K>, string>) {
    super(uiMessage.copyKey);
    this.name = 'PurchasingLocalError';
  }
}

export function purchasingErrorMessage<K extends string>(error: unknown, fallbackKey: K): PurchasingUiMessage<K> {
  if (error instanceof PurchasingLocalError) return error.uiMessage;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return { copyKey: fallbackKey };
}
