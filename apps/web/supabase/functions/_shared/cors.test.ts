import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getCorsHeaders,
  getDealerPreviewOrigins,
} from "./cors.ts";

const PREVIEW_ORIGIN = "https://bmq-ai-git-heo-dat-tet.vercel.app";
const SECOND_PREVIEW_ORIGIN = "https://bmq-ai-git-abc123.vercel.app";
const FUNCTION_BASE = "https://project.supabase.co/functions/v1";

function requestFor(functionName: string, origin?: string): Request {
  return new Request(`${FUNCTION_BASE}/${functionName}`, {
    headers: origin ? { origin } : {},
  });
}

function allowedOrigin(functionName: string, origin?: string): string {
  return getCorsHeaders(requestFor(functionName, origin))["Access-Control-Allow-Origin"];
}

function withPreviewOrigins(value: string, run: () => void): void {
  const previous = Deno.env.get("DEALER_PREVIEW_ORIGINS");
  Deno.env.set("DEALER_PREVIEW_ORIGINS", value);
  try {
    run();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("DEALER_PREVIEW_ORIGINS");
    } else {
      Deno.env.set("DEALER_PREVIEW_ORIGINS", previous);
    }
  }
}

Deno.test("preview origins are allowed for dealer-* functions only", () => {
  withPreviewOrigins(`${PREVIEW_ORIGIN}, ${SECOND_PREVIEW_ORIGIN}`, () => {
    assertEquals(allowedOrigin("dealer-heo", PREVIEW_ORIGIN), PREVIEW_ORIGIN);
    assertEquals(allowedOrigin("dealer-auth-start", SECOND_PREVIEW_ORIGIN), SECOND_PREVIEW_ORIGIN);
    // report-* and payslip-* keep their existing allow-lists.
    assert(allowedOrigin("report-bootstrap", PREVIEW_ORIGIN) !== PREVIEW_ORIGIN);
    assert(allowedOrigin("payslip-list", PREVIEW_ORIGIN) !== PREVIEW_ORIGIN);
  });
});

Deno.test("malformed preview origins are ignored", () => {
  const malformed = [
    "http://bmq-ai-git-heo.vercel.app",
    "https://bmq-ai-git-.vercel.app",
    "https://bmq-ai-git-heo.vercel.app.evil.com",
    "https://evil-bmq-ai-git-heo.vercel.app",
    "https://bmq-ai-git-heo.vercel.app/path",
    "https://BMQ-AI-GIT-HEO.vercel.app",
  ];

  withPreviewOrigins([PREVIEW_ORIGIN, ...malformed].join(","), () => {
    assertEquals(getDealerPreviewOrigins(), [PREVIEW_ORIGIN]);
    assertEquals(allowedOrigin("dealer-heo", PREVIEW_ORIGIN), PREVIEW_ORIGIN);
    malformed.forEach((origin) => {
      assert(allowedOrigin("dealer-heo", origin) !== origin);
    });
  });
});

Deno.test("missing DEALER_PREVIEW_ORIGINS keeps the previous CORS behaviour", () => {
  const previous = Deno.env.get("DEALER_PREVIEW_ORIGINS");
  Deno.env.delete("DEALER_PREVIEW_ORIGINS");
  try {
    assertEquals(getDealerPreviewOrigins(), []);
    assert(allowedOrigin("dealer-heo", PREVIEW_ORIGIN) !== PREVIEW_ORIGIN);
  } finally {
    if (previous !== undefined) Deno.env.set("DEALER_PREVIEW_ORIGINS", previous);
  }
});

Deno.test("dathang and the other public origins remain allowed", () => {
  withPreviewOrigins(PREVIEW_ORIGIN, () => {
    assertEquals(
      allowedOrigin("dealer-heo", "https://dathang.banhmique.vn"),
      "https://dathang.banhmique.vn",
    );
    assertEquals(
      allowedOrigin("report-bootstrap", "https://dathang.banhmique.vn"),
      "https://dathang.banhmique.vn",
    );
    assertEquals(
      allowedOrigin("dealer-heo", "https://ai.banhmique.vn"),
      "https://ai.banhmique.vn",
    );
  });
});
