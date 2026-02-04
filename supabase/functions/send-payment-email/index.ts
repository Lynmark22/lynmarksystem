// @ts-nocheck
// Deno Edge Function - types handled by Supabase runtime

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const RECIPIENT_EMAIL = "lynmarkapartment@gmail.com";

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const { senderName, senderGcash, senderContact, roomNo, amount, receiptUrl } = await req.json();

    // Validate required fields
    if (!senderName || !senderGcash || !roomNo || !amount) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create email HTML
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 10px; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .header { background: linear-gradient(135deg, #FF8C00, #FFA500); color: black; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; margin: -30px -30px 20px; }
          .header h1 { margin: 0; font-size: 22px; }
          .detail-row { display: flex; padding: 12px 0; border-bottom: 1px solid #eee; }
          .label { font-weight: bold; color: #555; width: 150px; }
          .value { color: #333; flex: 1; }
          .amount { font-size: 28px; font-weight: bold; color: #28a745; text-align: center; padding: 20px; background: #f8f9fa; border-radius: 10px; margin: 20px 0; }
          .receipt-link { display: inline-block; background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; margin-top: 15px; }
          .receipt-link:hover { background: #0056b3; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💳 New Payment Submission</h1>
          </div>
          
          <p style="color: #666; text-align: center;">A tenant has submitted a payment for review.</p>
          
          <div class="amount">₱${amount}</div>
          
          <div class="detail-row">
            <span class="label">Room Number:</span>
            <span class="value"><strong>${roomNo}</strong></span>
          </div>
          
          <div class="detail-row">
            <span class="label">Sender Name:</span>
            <span class="value">${senderName}</span>
          </div>
          
          <div class="detail-row">
            <span class="label">GCash Number:</span>
            <span class="value">${senderGcash}</span>
          </div>
          
          <div class="detail-row">
            <span class="label">Contact Number:</span>
            <span class="value">${senderContact || "Not provided"}</span>
          </div>
          
          <div class="detail-row">
            <span class="label">Submitted At:</span>
            <span class="value">${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</span>
          </div>
          
          ${receiptUrl ? `
          <div style="text-align: center; margin-top: 25px;">
            <p style="color: #555; margin-bottom: 10px;">📎 Receipt Image Attached</p>
            <a href="${receiptUrl}" class="receipt-link" target="_blank">
              View Receipt Image
            </a>
          </div>
          ` : ""}
          
          <div class="footer">
            <p>This is an automated notification from Lynmark Boarding House Billing System.</p>
            <p>Please verify the payment and update the bill status accordingly.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email via Resend API
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Lynmark Billing <onboarding@resend.dev>",
        to: [RECIPIENT_EMAIL],
        subject: `💳 Payment Submission - ${roomNo} - ₱${amount}`,
        html: emailHtml,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Resend API error:", result);
      return new Response(
        JSON.stringify({ error: "Failed to send email", details: result }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, messageId: result.id }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );

  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      }
    );
  }
});
