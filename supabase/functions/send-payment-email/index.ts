import "jsr:@supabase/functions-js@2.102.0/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FROM_EMAIL = Deno.env.get("SEND_PAYMENT_FROM_EMAIL") ??
  "Lynmark Billing <onboarding@resend.dev>";
const RECIPIENT_EMAIL = Deno.env.get("SEND_PAYMENT_RECIPIENT_EMAIL") ??
  "lynmarkapartment@gmail.com";
const ALLOWED_ORIGIN = Deno.env.get("SEND_PAYMENT_ALLOWED_ORIGIN") ?? "";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://lmvouchersystem.vercel.app",
  "https://lynmarksystem.vercel.app",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];
const SEND_PAYMENT_EMAIL_LIMIT = {
  scope: "send_payment_email",
  maxRequests: 5,
  windowSeconds: 300,
  blockSeconds: 1800,
};

type SendPaymentPayload = {
  submissionId?: string;
  senderName?: string;
  senderGcash?: string;
  senderContact?: string;
  roomNo?: string;
  amount?: string | number;
  receiptUrl?: string;
  periodStart?: string;
  periodEnd?: string;
  month?: string;
  prevReading?: string | number;
  currReading?: string | number;
  kwhUsed?: string | number;
  rate?: string | number;
};

type PaymentSubmissionRecord = {
  id: string;
  sender_gcash_number: string;
  sender_full_name: string;
  sender_contact_number: string;
  room_no: string;
  amount_to_pay: number | string;
  receipt_image_url: string | null;
  status: string | null;
  submitted_at: string | null;
};

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function getAllowedOrigins(configValue: string) {
  const normalizedConfig = configValue.trim();
  if (!normalizedConfig) {
    return DEFAULT_ALLOWED_ORIGINS.map((value) => normalizeOrigin(value));
  }

  if (normalizedConfig === "*") {
    return ["*"];
  }

  return normalizedConfig
    .split(",")
    .map((value) => normalizeOrigin(value))
    .filter(Boolean);
}

function buildCorsHeaders(req: Request) {
  const requestOrigin = normalizeOrigin(req.headers.get("origin") ?? "");
  const allowedOrigins = getAllowedOrigins(ALLOWED_ORIGIN);
  const allowAnyOrigin = allowedOrigins.includes("*");
  const isAllowedOrigin = requestOrigin &&
    (allowAnyOrigin || allowedOrigins.includes(requestOrigin));
  const responseOrigin = allowAnyOrigin
    ? "*"
    : isAllowedOrigin
    ? requestOrigin
    : "null";

  return {
    "Access-Control-Allow-Origin": responseOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(req),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function requireAllowedOrigin(req: Request): Response | null {
  const allowedOrigins = getAllowedOrigins(ALLOWED_ORIGIN);
  if (allowedOrigins.includes("*")) {
    return null;
  }

  const origin = normalizeOrigin(req.headers.get("origin") ?? "");
  if (!origin || !allowedOrigins.includes(origin)) {
    return jsonResponse(req, {
      success: false,
      error: "Origin not allowed",
    }, 403);
  }

  return null;
}

function requireJsonBody(req: Request, maxBytes = 64 * 1024): Response | null {
  const contentType = String(req.headers.get("content-type") ?? "").toLowerCase();
  const contentLength = Number(req.headers.get("content-length") ?? "0");

  if (!contentType.includes("application/json")) {
    return jsonResponse(req, {
      success: false,
      error: "Expected application/json request body",
    }, 415);
  }

  if (contentLength > maxBytes) {
    return jsonResponse(req, {
      success: false,
      error: "Request body is too large",
    }, 413);
  }

  return null;
}

function getRequestIp(req: Request): string {
  const forwardedFor = req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-forwarded-for")
    ?? req.headers.get("x-real-ip")
    ?? req.headers.get("fly-client-ip")
    ?? req.headers.get("x-vercel-forwarded-for")
    ?? "";

  return forwardedFor.split(",")[0]?.trim() || "unknown-ip";
}

function getRequestOrigin(req: Request): string {
  return normalizeOrigin(req.headers.get("origin") ?? "");
}

async function invokeRateLimitRpc(payload: Record<string, unknown>) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Anti-abuse shield is not configured. Missing Supabase service credentials.");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/security_check_rate_limit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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

async function checkRateLimit(
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

function normalizeText(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeComparableText(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function normalizeDigits(value: unknown) {
  return String(value ?? "").replace(/\D+/g, "");
}

function sanitizeSubjectText(value: unknown, fallback = "Unknown") {
  return normalizeText(value, fallback).replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
}

function formatDate(value?: string) {
  if (!value?.trim()) return "N/A";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "N/A";

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTimestamp() {
  return new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour12: true,
  });
}

function formatNumberDisplay(value: unknown, fallback = "0.00") {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return escapeHtml(normalizeText(value, fallback));
  }

  return numericValue.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function amountMatches(left: unknown, right: unknown) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) < 0.005;
  }

  return normalizeText(left) === normalizeText(right);
}

function contactMatches(left: unknown, right: unknown) {
  const leftDigits = normalizeDigits(left);
  const rightDigits = normalizeDigits(right);

  if (leftDigits || rightDigits) {
    return leftDigits === rightDigits;
  }

  return normalizeComparableText(left) === normalizeComparableText(right);
}

function receiptMatches(left: unknown, right: unknown) {
  const leftUrl = sanitizeUrl(left);
  const rightUrl = sanitizeUrl(right);

  if (!leftUrl && !rightUrl) return true;
  return leftUrl === rightUrl;
}

async function fetchPaymentSubmission(submissionId: string): Promise<PaymentSubmissionRecord | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Anti-abuse shield is not configured. Missing Supabase service credentials.");
  }

  const requestUrl = new URL(`${SUPABASE_URL}/rest/v1/payment_submissions`);
  requestUrl.searchParams.set(
    "select",
    "id,sender_gcash_number,sender_full_name,sender_contact_number,room_no,amount_to_pay,receipt_image_url,status,submitted_at",
  );
  requestUrl.searchParams.set("id", `eq.${submissionId}`);
  requestUrl.searchParams.set("limit", "1");

  const response = await fetch(requestUrl.toString(), {
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || data?.error || "Failed to verify payment submission.";
    throw new Error(message);
  }

  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0] as PaymentSubmissionRecord;
}

function submissionMatchesPayload(
  submission: PaymentSubmissionRecord,
  payload: SendPaymentPayload,
) {
  return normalizeComparableText(submission.sender_full_name) === normalizeComparableText(payload.senderName) &&
    contactMatches(submission.sender_gcash_number, payload.senderGcash) &&
    contactMatches(submission.sender_contact_number, payload.senderContact) &&
    normalizeComparableText(submission.room_no) === normalizeComparableText(payload.roomNo) &&
    amountMatches(submission.amount_to_pay, payload.amount) &&
    receiptMatches(submission.receipt_image_url, payload.receiptUrl);
}

function buildPaymentEmailHtml(payload: {
  senderName: string;
  senderGcash: string;
  senderContact: string;
  roomNo: string;
  amountDisplay: string;
  billingPeriod: string;
  prevReading: string;
  currReading: string;
  kwhUsed: string;
  rateDisplay: string;
  submittedAt: string;
  receiptUrl: string;
}) {
  const safeSenderName = escapeHtml(payload.senderName);
  const safeSenderGcash = escapeHtml(payload.senderGcash);
  const safeSenderContact = escapeHtml(payload.senderContact);
  const safeRoomNo = escapeHtml(payload.roomNo);
  const safeAmountDisplay = escapeHtml(payload.amountDisplay);
  const safeBillingPeriod = escapeHtml(payload.billingPeriod);
  const safePrevReading = escapeHtml(payload.prevReading);
  const safeCurrReading = escapeHtml(payload.currReading);
  const safeKwhUsed = escapeHtml(payload.kwhUsed);
  const safeRateDisplay = escapeHtml(payload.rateDisplay);
  const safeSubmittedAt = escapeHtml(payload.submittedAt);
  const safeReceiptUrl = escapeHtml(payload.receiptUrl);
  const currentYear = new Date().getFullYear();

  const receiptSection = payload.receiptUrl
    ? `
              <p style="margin:4px 0 12px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.09em;color:#1f3d63;text-align:center">
                Attached Receipt
              </p>
              <img src="${safeReceiptUrl}" alt="Payment Receipt" style="width:100%;max-width:540px;border-radius:12px;border:1px solid #d6e0ec;display:block;margin:0 auto" />
              <div style="text-align:center;margin-top:12px">
                <a href="${safeReceiptUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0b63b5;color:#fff !important;text-decoration:none;font-size:13px;font-weight:700">
                  Open Full Image
                </a>
              </div>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lynmark Payment Notification</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#132238">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    New payment submitted by ${safeSenderName} for room ${safeRoomNo}, amount PHP ${safeAmountDisplay}.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 10px;border-collapse:collapse">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#fff;border:1px solid #dce5f0;border-radius:16px;overflow:hidden;box-shadow:0 14px 35px rgba(15,33,62,0.12);border-collapse:collapse">
          <tr>
            <td style="background:linear-gradient(135deg,#0f2e56 0%,#0d4481 55%,#0a65bb 100%);padding:26px 24px 24px;color:#fff">
              <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:#08315f;background:#9fd6ff;margin-bottom:12px">
                Payment Notification
              </span>
              <h1 style="margin:0;font-size:24px;line-height:1.2;letter-spacing:0.01em">Lynmark Boarding House</h1>
              <p style="margin:8px 0 0;font-size:14px;color:rgba(255,255,255,0.88);line-height:1.45">
                A new electric billing payment was submitted and is waiting for admin review.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;background:#fff">
              <div style="background:linear-gradient(135deg,#ecfff3 0%,#e5fff8 100%);border:1px solid #b4eec8;border-left:5px solid #22b25a;border-radius:12px;padding:14px 16px;margin-bottom:18px">
                <p style="margin:0;color:#0f7f3d;font-size:20px;font-weight:800;line-height:1.2">New Payment Submitted</p>
                <p style="margin:6px 0 0;color:#186e40;font-size:14px;line-height:1.45">
                  Please verify the submission details and attached receipt before updating the billing status.
                </p>
              </div>

              <div style="border-radius:14px;border:1px solid #cfe4ff;background:linear-gradient(145deg,#edf5ff 0%,#f7fbff 100%);padding:18px 16px;text-align:center;margin-bottom:18px">
                <p style="margin:0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:#3e5f87">Amount Paid</p>
                <p style="margin:8px 0 0;font-size:44px;line-height:1;font-weight:900;color:#0c9f4e;letter-spacing:-0.02em">PHP ${safeAmountDisplay}</p>
                <p style="margin:6px 0 0;font-size:13px;color:#4e6a8b">Room ${safeRoomNo}</p>
              </div>

              <p style="margin:0 0 10px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.09em;color:#1f3d63">Submission Details</p>
              <div style="border:1px solid #dfe7f1;border-radius:12px;background:#fbfdff;overflow:hidden;margin-bottom:14px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Room Number</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeRoomNo}</td></tr>
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Sender Name</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeSenderName}</td></tr>
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">GCash Number</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeSenderGcash}</td></tr>
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Contact Number</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeSenderContact}</td></tr>
                  <tr><td style="padding:11px 14px;font-size:14px;color:#4d6583;font-weight:600">Submitted On</td><td style="padding:11px 14px;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeSubmittedAt}</td></tr>
                </table>
              </div>

              <p style="margin:0 0 10px;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.09em;color:#1f3d63">Billing Information</p>
              <div style="border:1px solid #dfe7f1;border-radius:12px;background:#fbfdff;overflow:hidden;margin-bottom:14px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Billing Period</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeBillingPeriod}</td></tr>
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Readings (Prev - Curr)</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safePrevReading} - ${safeCurrReading}</td></tr>
                  <tr><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#4d6583;font-weight:600">Total Usage</td><td style="padding:11px 14px;border-bottom:1px solid #edf2f7;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">${safeKwhUsed} kWh</td></tr>
                  <tr><td style="padding:11px 14px;font-size:14px;color:#4d6583;font-weight:600">Rate per kWh</td><td style="padding:11px 14px;font-size:14px;color:#0f2138;font-weight:800;text-align:right;word-break:break-word">PHP ${safeRateDisplay}</td></tr>
                </table>
              </div>

              ${receiptSection}
            </td>
          </tr>
          <tr>
            <td style="background:#0e1f36;color:rgba(255,255,255,0.78);text-align:center;padding:18px 16px;font-size:12px;line-height:1.5">
              <div style="color:#fff;font-weight:700">System Generated Notification</div>
              <div>&copy; ${currentYear} Lynmark Boarding House. All rights reserved.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: buildCorsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, {
      success: false,
      error: "Method not allowed",
    }, 405);
  }

  const originError = requireAllowedOrigin(req);
  if (originError) {
    return originError;
  }

  const bodyError = requireJsonBody(req, 64 * 1024);
  if (bodyError) {
    return bodyError;
  }

  if (!RESEND_API_KEY) {
    console.error("[CONFIG] Missing RESEND_API_KEY secret.");
    return jsonResponse(req, {
      success: false,
      error: "Email service is not configured.",
    }, 500);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[CONFIG] Missing Supabase anti-abuse configuration.");
    return jsonResponse(req, {
      success: false,
      error: "Payment email protection is not configured.",
    }, 503);
  }

  try {
    const payload = await req.json() as SendPaymentPayload;
    const submissionId = normalizeText(payload.submissionId);

    if (
      !submissionId || !payload.senderName || !payload.senderGcash ||
      !payload.senderContact || !payload.roomNo || payload.amount === undefined ||
      payload.amount === null || !payload.receiptUrl
    ) {
      return jsonResponse(
        req,
        { success: false, error: "Missing required fields" },
        400,
      );
    }

    const rateLimit = await checkRateLimit(req, {
      ...SEND_PAYMENT_EMAIL_LIMIT,
      fingerprint: "payment-email",
    });

    if (!rateLimit.allowed) {
      return jsonResponse(
        req,
        {
          success: false,
          error: "Too many email requests from this network. Please wait before trying again.",
        },
        429,
        rateLimit.headers,
      );
    }

    const submission = await fetchPaymentSubmission(submissionId);
    if (!submission) {
      return jsonResponse(req, {
        success: false,
        error: "Payment submission not found.",
      }, 404, rateLimit.headers);
    }

    if (!submissionMatchesPayload(submission, payload)) {
      return jsonResponse(req, {
        success: false,
        error: "Payment submission verification failed.",
      }, 403, rateLimit.headers);
    }

    const senderName = normalizeText(submission.sender_full_name);
    const senderGcash = normalizeText(submission.sender_gcash_number);
    const senderContact = normalizeText(submission.sender_contact_number, "-");
    const roomNo = normalizeText(submission.room_no);

    let billingPeriod = "N/A";
    if (
      normalizeText(payload.periodStart) && normalizeText(payload.periodEnd)
    ) {
      billingPeriod = `${formatDate(payload.periodStart)} - ${
        formatDate(payload.periodEnd)
      }`;
    } else if (normalizeText(payload.month)) {
      billingPeriod = formatDate(payload.month);
    }

    const amountDisplay = formatNumberDisplay(submission.amount_to_pay ?? payload.amount);
    const rateDisplay = formatNumberDisplay(payload.rate, "0.00");
    const submittedAt = formatTimestamp();
    const receiptUrl = sanitizeUrl(submission.receipt_image_url ?? payload.receiptUrl);

    const emailStart = Date.now();
    const emailHtml = buildPaymentEmailHtml({
      senderName,
      senderGcash,
      senderContact,
      roomNo,
      amountDisplay,
      billingPeriod,
      prevReading: normalizeText(payload.prevReading, "-"),
      currReading: normalizeText(payload.currReading, "-"),
      kwhUsed: normalizeText(payload.kwhUsed, "0"),
      rateDisplay,
      submittedAt,
      receiptUrl,
    });

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: RECIPIENT_EMAIL,
        subject: `Payment Submission: Room ${sanitizeSubjectText(roomNo)} (${
          sanitizeSubjectText(senderName)
        }) - PHP ${amountDisplay}`,
        html: emailHtml,
      }),
    });

    const emailDuration = Date.now() - emailStart;
    const resendResult = await emailRes.json().catch(() => null);

    if (!emailRes.ok) {
      console.error("[ERROR] Resend API error", {
        status: emailRes.status,
        body: resendResult,
      });
      return jsonResponse(req, {
        success: false,
        error: "Email send failed",
      }, 502, rateLimit.headers);
    }

    const totalDuration = Date.now() - startTime;
    return jsonResponse(req, {
      success: true,
      submissionId,
      timing: {
        totalMs: totalDuration,
        emailApiMs: emailDuration,
        sentAt: new Date().toISOString(),
      },
    }, 200, rateLimit.headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const failedAfterMs = Date.now() - startTime;
    console.error(
      `[ERROR] send-payment-email failed after ${failedAfterMs}ms: ${message}`,
    );

    return jsonResponse(req, {
      success: false,
      error: "Request processing failed",
      timing: { failedAfterMs },
    }, 500);
  }
});
