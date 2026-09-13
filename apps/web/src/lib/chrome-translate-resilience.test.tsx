// @ts-nocheck
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/contexts/LanguageContext";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "operator@bmq.vn", user_metadata: { full_name: "Operator" } },
    profile: { full_name: "Operator", email: "operator@bmq.vn" },
    signOut: vi.fn(),
    refreshProfile: vi.fn(),
    isOwner: true,
    loading: false,
    timedOut: false,
    authzLoaded: true,
    canAccessModule: () => true,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }),
  },
}));

vi.mock("@/hooks/usePaymentStats", () => ({
  usePaymentStats: () => ({ data: { pendingCount: 0 } }),
}));

vi.mock("@/hooks/usePurchaseOrders", () => ({
  useDraftPOCount: () => ({ data: 0 }),
}));

vi.mock("@/components/payment-requests/DriveImportProgressDialog", () => ({
  DriveImportProgressDialog: () => null,
}));

vi.mock("@/hooks/useAutoSync", () => ({
  useAutoSync: () => undefined,
}));

vi.mock("@/hooks/useVisibilityRecovery", () => ({
  useVisibilityRecovery: () => undefined,
}));

vi.mock("@/components/agent/GlobalAgentChatWidget", () => ({
  GlobalAgentChatWidget: () => null,
}));

vi.mock("@/pages/FinanceControl", async () => {
  const ReactModule = await import("react");
  return {
    default: ({ mode }: { mode: string }) => ReactModule.createElement("main", { "aria-label": "classification-real-route" }, `FinanceControl ${mode}`),
  };
});

const originalHasPointerCapture = Element.prototype.hasPointerCapture;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

const replaceFirstTextNode = (root: ParentNode, match: string, replacement: string) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent?.includes(match)) {
      const translated = document.createTextNode(replacement);
      node.parentNode?.replaceChild(translated, node);
      return;
    }
    node = walker.nextNode();
  }
  throw new Error(`Text node not found: ${match}`);
};

const getLanguageTrigger = (container: HTMLElement) => {
  const trigger = Array.from(container.querySelectorAll<HTMLElement>("[role='combobox']")).find((node) =>
    node.textContent?.includes("English") || node.textContent?.includes("Tiếng Việt") || node.textContent?.includes("Vietnamese"),
  );
  if (!trigger) throw new Error("Language select trigger not found");
  return trigger;
};

const openSelect = async (trigger: HTMLElement) => {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(document.body.querySelector("[role='listbox']")).toBeTruthy();
};

const chooseOption = async (label: string) => {
  const option = Array.from(document.body.querySelectorAll<HTMLElement>("[role='option']")).find((node) =>
    node.textContent?.includes(label),
  );
  if (!option) throw new Error(`Select option not found: ${label}`);
  await act(async () => {
    option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const renderWithProviders = async (root: Root, ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          {ui}
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
};

describe("synthetic Chrome Translate DOM replacement resilience", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem("app-language", "vi");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.scrollIntoView = vi.fn();
    window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0);
    window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    Element.prototype.hasPointerCapture = originalHasPointerCapture;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    window.matchMedia = originalMatchMedia;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.restoreAllMocks();
  });

  test.each([
    ["desktop", false],
    ["mobile", true],
  ])("Settings language select opens and updates real language state on %s", async (_label, mobile) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width") ? mobile : !mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { default: Settings } = await import("@/pages/Settings");
    await renderWithProviders(root, <Settings />);

    const trigger = getLanguageTrigger(container);
    expect(trigger.textContent).toContain("Tiếng Việt");
    await openSelect(trigger);
    expect(document.body.textContent).toContain("English");

    await chooseOption("English");
    expect(getLanguageTrigger(container).textContent).toContain("English");
    expect(container.textContent).toContain("Settings");

    await openSelect(getLanguageTrigger(container));
    await chooseOption("Tiếng Việt");
    expect(getLanguageTrigger(container).textContent).toContain("Tiếng Việt");
    expect(container.textContent).toContain("Cài đặt");
  });

  test.each([
    ["desktop", false],
    ["mobile", true],
  ])("Settings translated language select survives open, retranslate, and switch back on %s", async (_label, mobile) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width") ? mobile : !mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { default: Settings } = await import("@/pages/Settings");
    await renderWithProviders(root, <Settings />);

    replaceFirstTextNode(container, "Tiếng Việt", "Vietnamese");
    await openSelect(getLanguageTrigger(container));
    await chooseOption("English");
    expect(getLanguageTrigger(container).textContent).toContain("English");

    replaceFirstTextNode(container, "English", "Translated English");
    await openSelect(getLanguageTrigger(container));
    await chooseOption("Tiếng Việt");
    expect(getLanguageTrigger(container).textContent).toContain("Tiếng Việt");
  });

  test.each([
    ["desktop", false],
    ["mobile", true],
  ])("real Sidebar classification link navigates through AppRoutes away from translated Settings select on %s", async (_label, mobile) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width") ? mobile : !mobile,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { AppRoutes } = await import("@/components/AppRoutes");
    await renderWithProviders(
      root,
      <MemoryRouter initialEntries={["/settings"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    replaceFirstTextNode(container, "Tiếng Việt", "Vietnamese");
    if (mobile) {
      await act(async () => {
        window.dispatchEvent(new Event("bmq:open-sidebar"));
      });
    }
    const link = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) => anchor.getAttribute("href") === "/finance-control/classification");
    expect(link).toBeTruthy();
    expect(link?.textContent).toContain("Phân loại");

    await act(async () => {
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector("[aria-label='classification-real-route']")).toBeTruthy();
    expect(container.textContent).toContain("FinanceControl classification");
  });
});
