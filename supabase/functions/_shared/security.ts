/// <reference path="./deno-globals.d.ts" />

const DEFAULT_ALLOWED_HEADERS = "authorization, x-client-info, apikey, content-type";
const DEFAULT_ALLOWED_METHODS = "POST, OPTIONS";

function normalizeOrigin(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

function getAllowedOrigins(): string[] {
  return String(Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => normalizeOrigin(value))
    .filter(Boolean);
}

export function getRequestIp(req: Request): string {
  const forwardedFor = req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")
    ?? req.headers.get("x-real-ip")
    ?? req.headers.get("fly-client-ip")
    ?? req.headers.get("x-vercel-forwarded-for")
    ?? "";

  return forwardedFor.split(",")[0]?.trim() || "unknown-ip";
}

export function getRequestOrigin(req: Request): string {
  return normalizeOrigin(req.headers.get("origin"));
}

export function buildCorsHeaders(req: Request, extraHeaders: Record<string, string> = {}): Record<string, string> {
  const requestOrigin = req.headers.get("origin");
  const normalizedOrigin = normalizeOrigin(requestOrigin);
  const allowedOrigins = getAllowedOrigins();
  const allowOrigin = requestOrigin && (!allowedOrigins.length || allowedOrigins.includes(normalizedOrigin))
    ? requestOrigin
    : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": DEFAULT_ALLOWED_METHODS,
    "Vary": "Origin",
    ...extraHeaders,
  };
}

export function jsonResponse(
  req: Request,
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...buildCorsHeaders(req, extraHeaders),
      "Content-Type": "application/json",
    },
  });
}

export function requireAllowedOrigin(req: Request): { ok: true } | { ok: false; response: Response } {
  const allowedOrigins = getAllowedOrigins();
  if (!allowedOrigins.length) {
    return { ok: true };
  }

  const origin = getRequestOrigin(req);
  if (!origin || !allowedOrigins.includes(origin)) {
    return {
      ok: false,
      response: jsonResponse(req, { error: "Origin not allowed." }, 403),
    };
  }

  return { ok: true };
}

export function requireJsonBody(
  req: Request,
  maxBytes = 64 * 1024,
): { ok: true } | { ok: false; response: Response } {
  const contentType = String(req.headers.get("content-type") ?? "").toLowerCase();
  const contentLength = Number(req.headers.get("content-length") ?? "0");

  if (!contentType.includes("application/json")) {
    return {
      ok: false,
      response: jsonResponse(req, { error: "Expected application/json request body." }, 415),
    };
  }

  if (contentLength > maxBytes) {
    return {
      ok: false,
      response: jsonResponse(req, { error: "Request body is too large." }, 413),
    };
  }

  return { ok: true };
}

async function invokeRateLimitRpc(payload: Record<string, unknown>) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Security shield is not configured. Missing Supabase service credentials.");
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/security_check_rate_limit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message = data?.message || data?.error || "Failed to evaluate the rate limit policy.";
    throw new Error(message);
  }

  return data ?? {};
}

export async function checkRateLimit(
  req: Request,
  {
    scope,
    fingerprint = "",
    maxRequests,
    windowSeconds,
    blockSeconds,
  }: {
    scope: string;
    fingerprint?: string;
    maxRequests: number;
    windowSeconds: number;
    blockSeconds: number;
  },
): Promise<{
  allowed: boolean;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  const payload = await invokeRateLimitRpc({
    p_scope: scope,
    p_subject: [getRequestIp(req), req.headers.get("user-agent") ?? "unknown-agent", fingerprint].filter(Boolean).join("|"),
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
    p_block_seconds: blockSeconds,
    p_metadata: {
      origin: getRequestOrigin(req),
      pathname: new URL(req.url).pathname,
      method: req.method,
    },
  });

  const retryAfterSeconds = Number(payload?.retry_after_seconds ?? 0);
  const remaining = Number(payload?.remaining ?? 0);

  return {
    allowed: Boolean(payload?.allowed),
    payload,
    headers: {
      "X-RateLimit-Limit": String(maxRequests),
      "X-RateLimit-Remaining": String(Math.max(remaining, 0)),
      ...(retryAfterSeconds > 0 ? { "Retry-After": String(retryAfterSeconds) } : {}),
    },
  };
}
