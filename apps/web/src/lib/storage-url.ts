import { supabase } from "@/integrations/supabase/client";

const DEFAULT_BUCKET_CANDIDATES = ["invoices", "purchase-orders", "payment-slips", "payment-requests"];

type ResolveOptions = {
  preferredBucket?: string;
  expiresIn?: number;
};

function stripQueryAndHash(input: string) {
  return input.split("?")[0].split("#")[0];
}

function parseStorageUrl(raw: string): { bucket: string; path: string } | null {
  try {
    const u = new URL(raw);
    const marker = "/storage/v1/object/";
    const idx = u.pathname.indexOf(marker);
    if (idx < 0) return null;

    const tail = u.pathname.slice(idx + marker.length);
    const parts = tail.split("/").filter(Boolean);
    if (parts.length < 3) return null;

    const visibility = parts[0]; // public|sign|authenticated
    if (!["public", "sign", "authenticated"].includes(visibility)) return null;

    const bucket = parts[1];
    const path = decodeURIComponent(parts.slice(2).join("/"));
    if (!bucket || !path) return null;
    return { bucket, path };
  } catch {
    return null;
  }
}

async function sign(bucket: string, path: string, expiresIn: number): Promise<string | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

export async function resolveImageUrl(rawPathOrUrl: string | null | undefined, options?: ResolveOptions): Promise<string | null> {
  if (!rawPathOrUrl) return null;
  const input = String(rawPathOrUrl).trim();
  if (!input) return null;

  const expiresIn = options?.expiresIn ?? 3600;

  if (/^https?:\/\//i.test(input)) {
    const parsed = parseStorageUrl(input);
    if (parsed) {
      const resigned = await sign(parsed.bucket, parsed.path, expiresIn);
      return resigned || input;
    }
    return input;
  }

  const cleaned = stripQueryAndHash(input).replace(/^\/+/, "");
  if (!cleaned) return null;

  const bucketCandidates = [
    ...(options?.preferredBucket ? [options.preferredBucket] : []),
    ...DEFAULT_BUCKET_CANDIDATES,
  ].filter((v, i, arr) => !!v && arr.indexOf(v) === i);

  for (const bucket of bucketCandidates) {
    // raw path
    const signedRaw = await sign(bucket, cleaned, expiresIn);
    if (signedRaw) return signedRaw;

    // handle legacy value containing "bucket/path"
    const prefix = `${bucket}/`;
    if (cleaned.startsWith(prefix)) {
      const signedTrimmed = await sign(bucket, cleaned.slice(prefix.length), expiresIn);
      if (signedTrimmed) return signedTrimmed;
    }
  }

  return null;
}
