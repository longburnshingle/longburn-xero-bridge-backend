# Longburn Industries Xero Bridge — setup guide

This is a small server (a Cloudflare Worker — free tier is plenty) that sits
between the invoice-builder app and Xero. It holds the Xero connection and
creates DRAFT invoices when the app asks it to.

You only need to do this setup once. Total time: ~15 minutes.

## 1. Register a Xero app

1. Go to https://developer.xero.com/app/manage and log in with your Xero login.
2. Click **New app**.
3. App type: **Web app**.
4. Redirect URI: you don't know your Worker's URL yet, so put a placeholder
   like `https://placeholder.workers.dev/callback` — you'll come back and
   fix this in step 5 once you know the real URL.
5. Save, then open the app and copy the **Client ID** and generate a
   **Client Secret**. Keep both somewhere safe — you'll need them shortly.

## 2. Install the tools

You need Node.js installed (https://nodejs.org — LTS version). Then:

```bash
npm install -g wrangler
wrangler login
```

This opens a browser tab to connect Wrangler to your (free) Cloudflare account.
If you don't have one, it'll prompt you to create one — no credit card needed
for this.

## 3. Create the KV storage namespace

This is where your Xero connection (refresh token) is stored.

```bash
cd xero-invoice-worker
wrangler kv namespace create XERO_TOKENS
```

This prints an `id`. Open `wrangler.toml` and replace
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id.

## 4. Set your secrets

```bash
wrangler secret put XERO_CLIENT_ID
# paste the Client ID from step 1

wrangler secret put XERO_CLIENT_SECRET
# paste the Client Secret from step 1

wrangler secret put STAFF_USERNAME
# the username staff will type to sign into the invoice app

wrangler secret put STAFF_PASSWORD
# the password staff will type to sign into the invoice app
# this is a single shared login for the team, not per-staff accounts
```

### Email summary (optional but recommended)

Every time an invoice is sent to Xero, the worker can also email a summary
to your company inbox. This uses Resend (free for up to 100 emails/day,
no card needed):

1. Sign up at https://resend.com and verify a sending domain you own (e.g.
   `longburnindustries.co.nz`) under **Domains** — this takes a few minutes and
   just needs a DNS record added, same as setting up any business email.
   While testing, you can skip this and send from `onboarding@resend.dev` instead.
2. Create an API key under **API Keys**.
3. Set the remaining secrets:

```bash
wrangler secret put RESEND_API_KEY
# paste your Resend API key

wrangler secret put FROM_EMAIL
# e.g. invoices@longburnindustries.co.nz (or onboarding@resend.dev while testing)

wrangler secret put COMPANY_EMAIL
# the inbox that should receive the invoice summary, e.g. office@longburnindustries.co.nz
```

If you skip this section, invoice creation still works fine — you just won't
get the email summary.

## 5. Deploy

```bash
wrangler deploy
```

This prints your live URL, something like:

```
https://longburn-industries-xero-bridge.<your-subdomain>.workers.dev
```

Go back to https://developer.xero.com/app/manage, open your app, and update
the **Redirect URI** to:

```
https://longburn-industries-xero-bridge.<your-subdomain>.workers.dev/callback
```

### Optional: custom subdomain for the worker

The `workers.dev` URL above works fine as-is. If you'd rather have the
worker live at something like `xero-api.longburnindustries.co.nz`, add that
as a custom domain in the Cloudflare dashboard under
**Workers & Pages → longburn-industries-xero-bridge → Settings → Domains &
Routes**, then use that URL instead everywhere below (Redirect URI, and the
Worker URL you paste into the app).

## 6. Connect it to your Xero organisation (one-time)

Visit this in your browser, logged in as the Xero user for Longburn Industries Ltd
Company:

```
https://longburn-industries-xero-bridge.<your-subdomain>.workers.dev/connect
```

Approve access. You'll land on a page saying "Connected to Xero". That's it —
the worker now stores a refresh token and will keep itself signed in
automatically (Xero refresh tokens are valid for 60 days of inactivity, and
every invoice you create resets that clock).

You can check the connection any time at:

```
https://longburn-industries-xero-bridge.<your-subdomain>.workers.dev/status
```

## 7. Point the invoice app at your worker

Open the invoice builder app, scroll to **Xero Connection**, and enter:
- **Worker URL**: `https://longburn-industries-xero-bridge.<your-subdomain>.workers.dev`

Then sign in at the app's login screen with the **STAFF_USERNAME** /
**STAFF_PASSWORD** you set in step 4 — that's what authorises the app to
call your worker now (there's no separate API key to paste in). The login
is remembered for the browser tab's session; closing the tab signs out.

Tap **Send to Xero (draft)** on any invoice from now on — it'll appear in
Xero under **Business → Invoices → Drafts**, ready for you to check and approve.

## 8. Keep customers linked correctly (no duplicates)

The app can pull your real Xero customer list so you pick from it instead of
typing a free-text name that might not match exactly (which is how Xero ends
up creating duplicate customers).

- In the **Xero connection** card, tap **🔄 Refresh customer list** whenever
  you add a new customer in Xero — this fetches every customer and stores it
  on your phone for fast autocomplete.
- As you type a customer name, you'll see **✓ matched in Xero** once it finds
  an exact match, or **⚠ no match — will create a new customer** if it
  doesn't recognise the name. If you send with no match, it'll ask you to
  confirm first.
- Matched customers are linked by their actual Xero ContactID, so there's no
  ambiguity even if two customers have similar names.

The same idea applies to product **Code**s on each invoice line:

- Tap **🔄 Refresh product codes** to pull in your Xero inventory item codes
  (Business → Products and Services).
- A line's Code only gets sent to Xero as an item code once it matches a
  synced item (shown as **✓ Xero item**) — an unmatched code (**⚠ not sent
  as item code**) is still fine to use, it's just sent as plain text instead,
  since Xero rejects the whole invoice if an item code doesn't exist.

## 9. Invoicing grouped by order

Each invoice is grouped by the **Order number** field in the app (not by
date). You don't need to do anything extra once you're in the habit of
filling it in:

- The **Order number** you type goes straight into Xero's **Reference**
  field on the invoice, so it shows up there exactly as you typed it.
- Send lines under the same order number for the same customer more than
  once, and they get **added to that order's existing draft invoice**
  instead of creating a new one — as long as it's still sitting as a draft
  in Xero.
- As soon as you start a **new order number** for that customer, the next
  submission creates a **fresh invoice** — the previous order's invoice is
  left exactly as it was (closed off, still a draft, ready for you to
  review) and nothing more gets added to it.
- If someone approves the invoice in Xero before you're done with that
  order, the app notices on the next submission and starts a new draft
  rather than touching an invoice that's no longer a draft.
- The order number is required before sending to Xero — the app will prompt
  you if it's blank.
- The confirmation after each submission tells you whether it was **added to
  order X's invoice** or **started a new draft for order X**, and the email
  summary always shows the full invoice-to-date, not just what you just added.

## Notes

- Only staff who know the shared login can create invoices through this
  worker — share `STAFF_USERNAME`/`STAFF_PASSWORD` only with people who
  should be able to send invoices to Xero.
- The worker never stores your Xero login — only an OAuth token it can use
  on your behalf, which you can revoke any time from Xero under
  **Settings → Connected apps**.
- If Xero ever says "reconnect", just visit `/connect` again.
- If you ever change which Xero permissions the worker asks for (the
  `SCOPES` constant in `src/index.js`), you'll need to visit `/connect`
  again too — an existing connection doesn't pick up new scopes on its own.
