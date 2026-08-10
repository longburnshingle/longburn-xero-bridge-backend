/**
 * Longburn Industries Xero Bridge
 * -----------------------------------------------------------------
 * A small Cloudflare Worker that connects the invoice-builder web app
 * to Xero's Accounting API. It holds the Xero OAuth connection and
 * exposes one endpoint the app calls to create draft invoices.
 *
 * Endpoints:
 *   GET  /connect         -> start the one-time Xero authorization
 *   GET  /callback         -> Xero redirects here after you approve access
 *   GET  /status            -> check whether a Xero connection is stored
 *   GET  /contacts          -> list existing Xero customers (for the app's picker)
 *   GET  /items             -> list existing Xero inventory items (for the app's code picker)
 *   POST /create-invoice  -> add lines to a DRAFT invoice in Xero, then email a
 *                             summary to the company inbox (called by the app)
 *
 * Order-based invoicing: each customer's invoice is grouped by the Order
 * Number entered in the app, which also populates Xero's Reference field.
 * Sending more lines under the same order number appends them to that
 * order's existing draft invoice (as long as it's still a draft); entering a
 * new order number for that customer starts a fresh invoice and the previous
 * one is left as-is (closed off — no more lines get added to it). Tracked in
 * the XERO_TOKENS KV store.
 *
 * Required secrets (set with `wrangler secret put <NAME>`):
 *   XERO_CLIENT_ID, XERO_CLIENT_SECRET, STAFF_USERNAME, STAFF_PASSWORD,
 *   RESEND_API_KEY, FROM_EMAIL, COMPANY_EMAIL
 *
 * STAFF_USERNAME/STAFF_PASSWORD is a single shared login (Basic Auth) that
 * gates /contacts, /items and /create-invoice — same pattern as
 * longburn-pay-frontend's owner login, not per-staff accounts.
 *
 * Required binding (see wrangler.toml):
 *   XERO_TOKENS  (KV namespace)
 */

const TOKEN_KEY = "xero_tokens";
const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const INVOICES_URL = "https://api.xero.com/api.xro/2.0/Invoices";
const CONTACTS_URL = "https://api.xero.com/api.xro/2.0/Contacts";
const ITEMS_URL = "https://api.xero.com/api.xro/2.0/Items";
const SCOPES = "offline_access openid profile accounting.invoices accounting.contacts accounting.settings.read";
const RESEND_URL = "https://api.resend.com/emails";
const GST_RATE = { OUTPUT2: 0.15, ZERORATED: 0, NONE: 0 };

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/connect") return handleConnect(url, env);
      if (url.pathname === "/callback") return handleCallback(url, env);
      if (url.pathname === "/status") return handleStatus(env);
      if (url.pathname === "/contacts") return handleContacts(request, env);
      if (url.pathname === "/items") return handleItems(request, env);
      if (url.pathname === "/create-invoice" && request.method === "POST") {
        return handleCreateInvoice(request, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

function redirectUri(url) {
  return `${url.protocol}//${url.host}/callback`;
}

async function handleConnect(url, env) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: redirectUri(url),
    scope: SCOPES,
    state: "longburn-industries",
  });
  return Response.redirect(`${AUTHORIZE_URL}?${params.toString()}`, 302);
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return html("<p>Missing authorization code.</p>", 400);

  const basicAuth = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(url),
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return html(`<p>Token exchange failed: ${errText}</p>`, 500);
  }

  const tokens = await tokenRes.json();

  // Find which Xero organisation (tenant) was just connected
  const connRes = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const connections = await connRes.json();
  const tenant = connections[0];

  await saveTokens(env, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    tenant_id: tenant ? tenant.tenantId : null,
    tenant_name: tenant ? tenant.tenantName : null,
  });

  return html(
    `<p>Connected to Xero${tenant ? " — " + tenant.tenantName : ""}. You can close this tab and go back to the invoice builder.</p>`
  );
}

async function handleStatus(env) {
  const tokens = await getTokens(env);
  if (!tokens) return json({ connected: false });
  return json({ connected: true, tenant_name: tokens.tenant_name || null });
}

async function saveTokens(env, tokens) {
  await env.XERO_TOKENS.put(TOKEN_KEY, JSON.stringify(tokens));
}

async function getTokens(env) {
  const raw = await env.XERO_TOKENS.get(TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function getValidAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens) throw new Error("Not connected to Xero yet — visit /connect first.");

  // Refresh if the token is expired or expiring in the next 60 seconds
  if (Date.now() > tokens.expires_at - 60000) {
    const basicAuth = btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`);
    const refreshRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
    });
    if (!refreshRes.ok) {
      throw new Error("Xero refresh token expired — reconnect via /connect.");
    }
    const refreshed = await refreshRes.json();
    tokens.access_token = refreshed.access_token;
    tokens.refresh_token = refreshed.refresh_token; // Xero rotates this each time
    tokens.expires_at = Date.now() + refreshed.expires_in * 1000;
    await saveTokens(env, tokens);
  }

  return tokens;
}

// Single shared staff login (matches the pattern used by longburn-pay-frontend):
// the app sends "Authorization: Basic base64(username:password)" on every
// protected call, checked here against the STAFF_USERNAME/STAFF_PASSWORD
// secrets. Not per-staff accounts — one shared login for the team.
function staffAuthorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  return username === env.STAFF_USERNAME && password === env.STAFF_PASSWORD;
}

function unauthorized() {
  return json({ error: "Invalid or missing staff login" }, 401);
}

async function handleContacts(request, env) {
  if (!staffAuthorized(request, env)) return unauthorized();

  const tokens = await getValidAccessToken(env);
  const contacts = [];
  let page = 1;

  // Xero paginates at 100 per page. Loop until a page comes back short/empty.
  while (page <= 10) {
    const res = await fetch(
      `${CONTACTS_URL}?where=IsCustomer==true&order=Name ASC&page=${page}&summaryOnly=true`,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Xero-tenant-id": tokens.tenant_id,
          Accept: "application/json",
        },
      }
    );
    if (!res.ok) break;
    const data = await res.json();
    const batch = data.Contacts || [];
    batch.forEach((c) => contacts.push({ contactId: c.ContactID, name: c.Name }));
    if (batch.length < 100) break;
    page++;
  }

  return json({ contacts });
}

async function handleItems(request, env) {
  if (!staffAuthorized(request, env)) return unauthorized();

  const tokens = await getValidAccessToken(env);

  // The Items endpoint isn't paginated the way Contacts is — one call returns everything.
  const res = await fetch(`${ITEMS_URL}?where=IsSold==true&order=Code ASC`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Xero-tenant-id": tokens.tenant_id,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    return json({ error: "Could not fetch items from Xero", details: errText }, res.status);
  }

  const data = await res.json();
  const items = (data.Items || []).map((i) => ({ code: i.Code, description: i.Description || null }));

  return json({ items });
}

const OPEN_INVOICES_KEY = "open_invoices";
const ENTRY_PRUNE_MS = 90 * 24 * 60 * 60 * 1000; // drop tracking entries older than ~90 days

async function getOpenInvoices(env) {
  const raw = await env.XERO_TOKENS.get(OPEN_INVOICES_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function saveOpenInvoices(env, map) {
  const cutoff = Date.now() - ENTRY_PRUNE_MS;
  const pruned = {};
  for (const [key, entry] of Object.entries(map)) {
    if ((entry.createdAt || 0) >= cutoff) pruned[key] = entry;
  }
  await env.XERO_TOKENS.put(OPEN_INVOICES_KEY, JSON.stringify(pruned));
}

async function handleCreateInvoice(request, env) {
  if (!staffAuthorized(request, env)) return unauthorized();

  const payload = await request.json();
  const { contactId, contactName, orderNumber, invoiceNumber, invoiceDate, dueDate, lineItems } = payload;

  if (!contactName || !lineItems || lineItems.length === 0) {
    return json({ error: "contactName and at least one line item are required" }, 400);
  }
  if (!orderNumber || !orderNumber.trim()) {
    return json({ error: "orderNumber is required to group lines into the right invoice" }, 400);
  }

  const tokens = await getValidAccessToken(env);

  const contactKey = (contactId || contactName).toString().trim().toLowerCase();
  const orderKey = orderNumber.toString().trim().toLowerCase();
  const mapKey = `${contactKey}::${orderKey}`;
  const openMap = await getOpenInvoices(env);
  const existingEntry = openMap[mapKey];

  let targetInvoiceId = null;
  let existingLineItems = [];

  if (existingEntry) {
    const getRes = await fetch(`${INVOICES_URL}/${existingEntry.invoiceId}`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Xero-tenant-id": tokens.tenant_id,
        Accept: "application/json",
      },
    });
    if (getRes.ok) {
      const getData = await getRes.json();
      const existingInvoice = getData.Invoices && getData.Invoices[0];
      // Only append if it's still a draft — if it's been approved/paid/deleted
      // since, treat this week as needing a fresh invoice instead.
      if (existingInvoice && existingInvoice.Status === "DRAFT") {
        targetInvoiceId = existingInvoice.InvoiceID;
        existingLineItems = (existingInvoice.LineItems || []).map((li) => ({
          LineItemID: li.LineItemID,
          Description: li.Description,
          Quantity: li.Quantity,
          UnitAmount: li.UnitAmount,
          AccountCode: li.AccountCode,
          TaxType: li.TaxType,
          ...(li.ItemCode ? { ItemCode: li.ItemCode } : {}),
        }));
      }
    }
  }

  const newLineItems = lineItems.map((li) => ({
    Description: li.description,
    Quantity: li.quantity,
    UnitAmount: li.unitAmount,
    AccountCode: li.accountCode,
    TaxType: li.taxType,
    ...(li.itemCode ? { ItemCode: li.itemCode } : {}),
  }));

  const invoiceBody = {
    Type: "ACCREC",
    Contact: contactId ? { ContactID: contactId } : { Name: contactName },
    Date: invoiceDate,
    DueDate: dueDate,
    Reference: orderNumber.trim(),
    Status: "DRAFT",
    LineItems: existingLineItems.concat(newLineItems),
    ...(targetInvoiceId ? { InvoiceID: targetInvoiceId } : {}),
    ...(!targetInvoiceId && invoiceNumber ? { InvoiceNumber: invoiceNumber } : {}),
  };

  const res = await fetch(INVOICES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Xero-tenant-id": tokens.tenant_id,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(invoiceBody),
  });

  const result = await res.json();

  if (!res.ok) {
    return json({ error: "Xero rejected the invoice", details: result }, res.status);
  }

  const created = result.Invoices && result.Invoices[0];
  const appended = !!targetInvoiceId;

  if (created) {
    openMap[mapKey] = { invoiceId: created.InvoiceID, invoiceNumber: created.InvoiceNumber, createdAt: Date.now() };
    await saveOpenInvoices(env, openMap);
  }

  // Email the full invoice-to-date (existing lines + this submission), not just what was just added.
  const emailLineItems = existingLineItems
    .map((li) => ({ description: li.Description, quantity: li.Quantity, unitAmount: li.UnitAmount, taxType: li.TaxType }))
    .concat(lineItems);

  let emailSent = false;
  let emailError = null;
  try {
    if (env.RESEND_API_KEY && env.COMPANY_EMAIL) {
      await sendSummaryEmail(env, {
        contactName,
        invoiceNumber: created?.InvoiceNumber || invoiceNumber,
        orderNumber,
        invoiceDate,
        dueDate,
        lineItems: emailLineItems,
        appended,
      });
      emailSent = true;
    }
  } catch (err) {
    emailError = err.message || String(err);
  }

  return json({
    success: true,
    invoiceId: created ? created.InvoiceID : null,
    invoiceNumber: created ? created.InvoiceNumber : null,
    status: created ? created.Status : null,
    appended,
    emailSent,
    emailError,
  });
}

function money(n) {
  return "$" + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

async function sendSummaryEmail(env, { contactName, invoiceNumber, orderNumber, invoiceDate, dueDate, lineItems, appended }) {
  let subtotal = 0, gst = 0;
  const rowsHtml = lineItems.map((li) => {
    const lineTotal = (li.quantity || 0) * (li.unitAmount || 0);
    const rate = GST_RATE[li.taxType] ?? 0;
    const lineGst = lineTotal * rate;
    subtotal += lineTotal;
    gst += lineGst;
    return `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;">${escapeXml(li.description || "")}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${li.quantity}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${money(li.unitAmount || 0)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${money(lineTotal)}</td>
    </tr>`;
  }).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;color:#2B2822;max-width:560px;">
      <h2 style="margin-bottom:4px;">${appended ? "Lines added to this order's invoice (draft)" : "New invoice sent to Xero (draft)"}</h2>
      <p style="color:#655F53;margin-top:0;">Review and approve it in Xero when ready. Shown below is the full invoice-to-date.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px;">
        <tr><td style="padding:4px 8px;color:#655F53;">Customer</td><td style="padding:4px 8px;"><strong>${escapeXml(contactName)}</strong></td></tr>
        <tr><td style="padding:4px 8px;color:#655F53;">Order number (Reference)</td><td style="padding:4px 8px;">${escapeXml(orderNumber || "—")}</td></tr>
        <tr><td style="padding:4px 8px;color:#655F53;">Invoice number</td><td style="padding:4px 8px;">${escapeXml(invoiceNumber || "—")}</td></tr>
        <tr><td style="padding:4px 8px;color:#655F53;">Invoice date</td><td style="padding:4px 8px;">${invoiceDate || "—"}</td></tr>
        <tr><td style="padding:4px 8px;color:#655F53;">Due date</td><td style="padding:4px 8px;">${dueDate || "—"}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px;">
        <thead>
          <tr style="background:#F1ECE1;">
            <th style="padding:6px 8px;text-align:left;">Description</th>
            <th style="padding:6px 8px;text-align:right;">Qty</th>
            <th style="padding:6px 8px;text-align:right;">Unit price</th>
            <th style="padding:6px 8px;text-align:right;">Line total</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:10px;">
        <tr><td style="padding:4px 8px;color:#655F53;">Subtotal</td><td style="padding:4px 8px;text-align:right;">${money(subtotal)}</td></tr>
        <tr><td style="padding:4px 8px;color:#655F53;">GST</td><td style="padding:4px 8px;text-align:right;">${money(gst)}</td></tr>
        <tr><td style="padding:6px 8px;font-weight:bold;">Total</td><td style="padding:6px 8px;text-align:right;font-weight:bold;">${money(subtotal + gst)}</td></tr>
      </table>
    </div>`;

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: env.COMPANY_EMAIL,
      subject: `${appended ? "Line added to invoice" : "Invoice"} ${invoiceNumber || ""} sent to Xero — ${contactName}`.trim(),
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend error: ${errText}`);
  }
}

function escapeXml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
