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
      senderName, senderGcash, senderContact, roomNo, amount, receiptUrl,
      periodStart, periodEnd, month, prevReading, currReading, kwhUsed, rate
    } = await req.json();

    if (!senderName || !senderGcash || !roomNo || !amount) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Format Date Helper
    const formatDate = (d) => {
        if(!d) return "N/A";
        return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    
    // Determine billing period display
    let billingPeriod = "N/A";
    if (periodStart && periodEnd) {
        billingPeriod = `${formatDate(periodStart)} - ${formatDate(periodEnd)}`;
    } else if (month) {
        billingPeriod = formatDate(month);
    }

    const timestamp = new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: true });

    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
          .header { background-color: #FF8C00; color: #000000; padding: 25px; text-align: center; border-bottom: 4px solid #cc7000; }
          .header h1 { margin: 0; font-size: 20px; text-transform: uppercase; letter-spacing: 1px; font-weight: 800; }
          .header p { margin: 5px 0 0; font-size: 14px; opacity: 0.9; }
          
          .content { padding: 30px; }
          .alert-box { background-color: #e8f5e9; border-left: 5px solid #28a745; padding: 15px; margin-bottom: 25px; border-radius: 4px; }
          .alert-box h3 { margin: 0 0 5px; color: #155724; font-size: 18px; }
          .alert-box p { margin: 0; color: #155724; font-size: 14px; }

          .section-title { font-size: 14px; font-weight: bold; color: #555; text-transform: uppercase; border-bottom: 1px solid #ddd; padding-bottom: 8px; margin-bottom: 15px; margin-top: 25px; }
          
          table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
          td { padding: 8px 0; font-size: 15px; color: #333; vertical-align: top; border-bottom: 1px solid #f9f9f9; }
          td.label { width: 45%; color: #666; font-weight: 500; }
          td.value { width: 55%; font-weight: 700; color: #000; text-align: right; }
          
          .amount-box { text-align: center; background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px dashed #ccc; margin: 25px 0; }
          .amount-label { font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
          .amount-value { font-size: 36px; font-weight: 800; color: #28a745; margin: 5px 0; }
          
          .receipt-section { text-align: center; margin-top: 30px; border-top: 1px solid #eee; padding-top: 20px; }
          .receipt-img { max-width: 100%; border-radius: 8px; border: 1px solid #ddd; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-top: 15px; }
          
          .footer { background-color: #333; color: #fff; text-align: center; padding: 20px; font-size: 12px; }
          .footer p { margin: 5px 0; opacity: 0.7; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Lynmark Boarding House</h1>
            <p>Electric Billing Payment Notification</p>
          </div>
          
          <div class="content">
            <div class="alert-box">
              <h3>✅ New Payment Submitted</h3>
              <p>A tenant has submitted a payment for review.</p>
            </div>

            <div class="section-title">Submission Details</div>
            <table>
              <tr><td class="label">Room Number</td><td class="value">${roomNo}</td></tr>
              <tr><td class="label">Sender Name</td><td class="value">${senderName}</td></tr>
              <tr><td class="label">GCash Number</td><td class="value">${senderGcash}</td></tr>
              <tr><td class="label">Contact No.</td><td class="value">${senderContact || '-'}</td></tr>
              <tr><td class="label">Submitted On</td><td class="value">${timestamp}</td></tr>
            </table>

            <div class="section-title">Billing Information</div>
            <table>
              <tr><td class="label">Billing Period</td><td class="value">${billingPeriod}</td></tr>
              <tr><td class="label">Readings (Prev - Curr)</td><td class="value">${prevReading ?? '-'} - ${currReading ?? '-'}</td></tr>
              <tr><td class="label">Total Usage</td><td class="value">${kwhUsed ?? '0'} kWh</td></tr>
              <tr><td class="label">Rate per kWh</td><td class="value">₱${rate ?? '0.00'}</td></tr>
            </table>

            <div class="amount-box">
              <div class="amount-label">Amount Paid</div>
              <div class="amount-value">₱${amount}</div>
            </div>

            ${receiptUrl ? `
            <div class="receipt-section">
              <div class="section-title" style="margin-top:0; border:none; text-align:center;">Attached Receipt</div>
              <img src="${receiptUrl}" alt="Payment Receipt" class="receipt-img">
              <p style="margin-top:15px;"><a href="${receiptUrl}" style="color:#007bff; text-decoration:none; font-size:14px;">[Click to Open Full Image]</a></p>
            </div>
            ` : ''}
          </div>
          
          <div class="footer">
            <p>System Generated Notification</p>
            <p>&copy; ${new Date().getFullYear()} Lynmark Boarding House. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send email via Resend API
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: "Lynmark Billing <onboarding@resend.dev>",
        to: RECIPIENT_EMAIL,
        subject: `💳 Payment: ${roomNo} (${senderName}) - ₱${amount}`,
        html: emailHtml
      })
    });

    const data = await res.json();

    if (!res.ok) {
        console.error("Resend API Error:", data);
        return new Response(JSON.stringify({ error: "Failed to send email", details: data }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }

    return new Response(JSON.stringify({ success: true, id: data.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("Internal Function Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
