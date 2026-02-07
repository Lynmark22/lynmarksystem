// @ts-nocheck
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RECIPIENT_EMAIL = "lynmarkapartment@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      senderName,
      senderGcash,
      senderContact,
      roomNo,
      amount,
      receiptUrl,
      periodStart,
      periodEnd,
      month,
      prevReading,
      currReading,
      kwhUsed,
      rate,
    } = await req.json();

    if (!senderName || !senderGcash || !roomNo || !amount) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const formatDate = (d: string | null | undefined) => {
      if (!d) return "N/A";
      return new Date(d).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    };

    const escapeHtml = (value: unknown) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    let billingPeriod = "N/A";
    if (periodStart && periodEnd) {
      billingPeriod = `${formatDate(periodStart)} - ${formatDate(periodEnd)}`;
    } else if (month) {
      billingPeriod = formatDate(month);
    }

    const timestamp = new Date().toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      hour12: true,
    });

    const amountNumber = Number(amount);
    const amountDisplay = Number.isFinite(amountNumber)
      ? amountNumber.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      : escapeHtml(amount);

    const rateNumber = Number(rate);
    const rateDisplay = Number.isFinite(rateNumber)
      ? rateNumber.toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      : escapeHtml(rate ?? "0.00");

    const safeRoomNo = escapeHtml(roomNo);
    const safeSenderName = escapeHtml(senderName);
    const safeSenderGcash = escapeHtml(senderGcash);
    const safeSenderContact = escapeHtml(senderContact || "-");
    const safeTimestamp = escapeHtml(timestamp);
    const safeBillingPeriod = escapeHtml(billingPeriod);
    const safePrevReading = escapeHtml(prevReading ?? "-");
    const safeCurrReading = escapeHtml(currReading ?? "-");
    const safeKwhUsed = escapeHtml(kwhUsed ?? "0");
    const safeReceiptUrl = receiptUrl ? escapeHtml(receiptUrl) : "";
    const currentYear = new Date().getFullYear();

    const emailHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lynmark Payment Notification</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #eef2f7;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #132238;
    }
    table { border-collapse: collapse; }
    .mail-shell {
      width: 100%;
      max-width: 640px;
      background: #ffffff;
      border: 1px solid #dce5f0;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 14px 35px rgba(15, 33, 62, 0.12);
    }
    .hero {
      background: linear-gradient(135deg, #0f2e56 0%, #0d4481 55%, #0a65bb 100%);
      padding: 26px 24px 24px;
      color: #ffffff;
    }
    .eyebrow {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
      color: #08315f;
      background: #9fd6ff;
      margin-bottom: 12px;
    }
    .hero h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0.01em;
    }
    .hero p {
      margin: 8px 0 0;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.88);
      line-height: 1.45;
    }
    .content {
      padding: 24px;
      background: #ffffff;
    }
    .status-card {
      background: linear-gradient(135deg, #ecfff3 0%, #e5fff8 100%);
      border: 1px solid #b4eec8;
      border-left: 5px solid #22b25a;
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    .status-title {
      margin: 0;
      color: #0f7f3d;
      font-size: 20px;
      font-weight: 800;
      line-height: 1.2;
    }
    .status-desc {
      margin: 6px 0 0;
      color: #186e40;
      font-size: 14px;
      line-height: 1.45;
    }
    .amount-card {
      border-radius: 14px;
      border: 1px solid #cfe4ff;
      background: linear-gradient(145deg, #edf5ff 0%, #f7fbff 100%);
      padding: 18px 16px;
      text-align: center;
      margin-bottom: 18px;
    }
    .amount-label {
      margin: 0;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-weight: 700;
      color: #3e5f87;
    }
    .amount-value {
      margin: 8px 0 0;
      font-size: 44px;
      line-height: 1;
      font-weight: 900;
      color: #0c9f4e;
      letter-spacing: -0.02em;
    }
    .amount-note {
      margin: 6px 0 0;
      font-size: 13px;
      color: #4e6a8b;
    }
    .section-title {
      margin: 0 0 10px;
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: #1f3d63;
    }
    .card {
      border: 1px solid #dfe7f1;
      border-radius: 12px;
      background: #fbfdff;
      overflow: hidden;
      margin-bottom: 14px;
    }
    .details-table {
      width: 100%;
    }
    .details-table td {
      padding: 11px 14px;
      border-bottom: 1px solid #edf2f7;
      font-size: 14px;
      vertical-align: top;
    }
    .details-table tr:last-child td {
      border-bottom: none;
    }
    .details-label {
      width: 48%;
      color: #4d6583;
      font-weight: 600;
    }
    .details-value {
      width: 52%;
      color: #0f2138;
      font-weight: 800;
      text-align: right;
      word-break: break-word;
    }
    .receipt-title {
      margin: 4px 0 12px;
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: #1f3d63;
      text-align: center;
    }
    .receipt-img {
      width: 100%;
      max-width: 540px;
      border-radius: 12px;
      border: 1px solid #d6e0ec;
      display: block;
      margin: 0 auto;
    }
    .open-link {
      display: inline-block;
      margin-top: 12px;
      padding: 10px 14px;
      border-radius: 10px;
      background: #0b63b5;
      color: #ffffff !important;
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
    }
    .footer {
      background: #0e1f36;
      color: rgba(255, 255, 255, 0.78);
      text-align: center;
      padding: 18px 16px;
      font-size: 12px;
      line-height: 1.5;
    }
    .footer strong {
      color: #ffffff;
      font-weight: 700;
    }
    @media only screen and (max-width: 620px) {
      .hero, .content { padding: 18px 16px; }
      .hero h1 { font-size: 21px; }
      .amount-value { font-size: 38px; }
      .details-table td {
        display: block;
        width: 100% !important;
        text-align: left !important;
        padding: 8px 12px;
      }
      .details-label {
        padding-bottom: 0 !important;
        border-bottom: none !important;
      }
      .details-value {
        padding-top: 2px !important;
      }
    }
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    New payment submitted by ${safeSenderName} for ${safeRoomNo}, amount PHP ${amountDisplay}.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" class="mail-shell" cellpadding="0" cellspacing="0">
          <tr>
            <td class="hero">
              <span class="eyebrow">Payment Notification</span>
              <h1>Lynmark Boarding House</h1>
              <p>A new electric billing payment was submitted and is now waiting for admin review.</p>
            </td>
          </tr>
          <tr>
            <td class="content">
              <div class="status-card">
                <p class="status-title">New Payment Submitted</p>
                <p class="status-desc">Please verify the submission details and attached receipt before updating billing status.</p>
              </div>

              <div class="amount-card">
                <p class="amount-label">Amount Paid</p>
                <p class="amount-value">&#8369;${amountDisplay}</p>
                <p class="amount-note">Room ${safeRoomNo}</p>
              </div>

              <p class="section-title">Submission Details</p>
              <div class="card">
                <table role="presentation" class="details-table" cellpadding="0" cellspacing="0">
                  <tr><td class="details-label">Room Number</td><td class="details-value">${safeRoomNo}</td></tr>
                  <tr><td class="details-label">Sender Name</td><td class="details-value">${safeSenderName}</td></tr>
                  <tr><td class="details-label">GCash Number</td><td class="details-value">${safeSenderGcash}</td></tr>
                  <tr><td class="details-label">Contact Number</td><td class="details-value">${safeSenderContact}</td></tr>
                  <tr><td class="details-label">Submitted On</td><td class="details-value">${safeTimestamp}</td></tr>
                </table>
              </div>

              <p class="section-title">Billing Information</p>
              <div class="card">
                <table role="presentation" class="details-table" cellpadding="0" cellspacing="0">
                  <tr><td class="details-label">Billing Period</td><td class="details-value">${safeBillingPeriod}</td></tr>
                  <tr><td class="details-label">Readings (Prev - Curr)</td><td class="details-value">${safePrevReading} - ${safeCurrReading}</td></tr>
                  <tr><td class="details-label">Total Usage</td><td class="details-value">${safeKwhUsed} kWh</td></tr>
                  <tr><td class="details-label">Rate per kWh</td><td class="details-value">&#8369;${rateDisplay}</td></tr>
                </table>
              </div>

              ${safeReceiptUrl ? `
              <p class="receipt-title">Attached Receipt</p>
              <img src="${safeReceiptUrl}" alt="Payment Receipt" class="receipt-img" />
              <div style="text-align:center;">
                <a class="open-link" href="${safeReceiptUrl}" target="_blank" rel="noopener noreferrer">Open Full Image</a>
              </div>
              ` : ""}
            </td>
          </tr>
          <tr>
            <td class="footer">
              <div><strong>System Generated Notification</strong></div>
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

    // Send email via Resend API
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Lynmark Billing <onboarding@resend.dev>",
        to: RECIPIENT_EMAIL,
        subject: `Payment Submission: ${roomNo} (${senderName}) - PHP ${amountDisplay}`,
        html: emailHtml,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Resend API Error:", data);
      return new Response(JSON.stringify({ error: "Failed to send email", details: data }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Internal Function Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
