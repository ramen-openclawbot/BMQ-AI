import { createElement, useCallback, type ReactNode } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { people, type PeopleKey } from "@/i18n/people";
import { toast as sonnerToast } from "sonner";
import { SessionExpiredError } from "@/lib/session-errors";

type PeopleValues = Record<string, string | number>;
export type PeopleToastDescriptor = { key: PeopleKey; values?: PeopleValues };

export class PeopleLocalError extends Error {
  constructor(public readonly descriptor: PeopleToastDescriptor) {
    super(descriptor.key);
    this.name = "PeopleLocalError";
  }
}

export function usePeopleCopy() {
  const { language } = useLanguage();
  return useCallback((key: PeopleKey, values: PeopleValues = {}) =>
    people[language][key].replace(/\{(\w+)\}/g, (token, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token), [language]);
}

function PeopleToastText({ descriptor }: { descriptor: PeopleToastDescriptor }) {
  const pc = usePeopleCopy();
  return createElement("span", null, pc(descriptor.key, descriptor.values));
}

/** React content intentionally reads LanguageContext when Sonner renders it. */
export function peopleToast(key: PeopleKey, values?: PeopleValues): ReactNode {
  return createElement(PeopleToastText, { descriptor: { key, values } });
}

type PeopleToastOptions = { description?: ReactNode; duration?: number };

/** Render both fields in Sonner's mounted React tree so LanguageContext stays live. */
export function showPeopleToast(
  kind: "success" | "error",
  title: ReactNode,
  options: PeopleToastOptions = {},
) {
  const { description, ...sonnerOptions } = options;
  return sonnerToast.custom(() => createElement(
    "div",
    { className: "w-full rounded-lg border bg-background p-4 text-foreground shadow-lg", "data-people-toast": kind },
    createElement("div", { className: "font-semibold", "data-people-toast-title": true }, title),
    description == null ? null : createElement("div", { className: "mt-1 text-sm text-muted-foreground", "data-people-toast-description": true }, description),
  ), sonnerOptions);
}

/** Preserve nonblank backend messages exactly; localize only the unknown fallback. */
export function peopleErrorDescription(
  error: { message?: unknown } | null | undefined,
  fallbackKey: PeopleKey,
): ReactNode {
  if (error instanceof PeopleLocalError) return peopleToast(error.descriptor.key, error.descriptor.values);
  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : peopleToast(fallbackKey);
}

/** Localize only the typed client auth failure; preserve backend text verbatim. */
export function peopleSupabaseErrorDescription(
  error: { message?: unknown } | null | undefined,
  fallbackKey: PeopleKey,
): ReactNode {
  if (error instanceof SessionExpiredError) return peopleToast("sessionExpiredRelogin");
  return peopleErrorDescription(error, fallbackKey);
}

// Retained for non-toast render boundaries. Backend text is never translated here.
export function usePeopleAuthError() {
  return (error: { message?: string } | null | undefined) => error?.message;
}
