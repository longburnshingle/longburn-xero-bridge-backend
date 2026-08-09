# Project context — Longburn Industries invoice → Xero app

Read this first. It captures decisions made in a planning conversation before
any of this code reached your machine — the "why," not just the "what."

## What this project is

A mobile-friendly web app for **Longburn Industries Ltd** (aggregate
supplier, Palmerston North, NZ — formerly traded as Longburn Shingle
Company) that lets staff build invoice lines on their phone and push them
straight into Xero as draft invoices, instead of typing into Xero directly
or emailing spreadsheets around.

Two parts, in this repo:
- **`/app`** (or wherever `invoice-builder.html` lives) — the front-end.
  Plain HTML/JS, no build step. Meant to be opened as a PWA (add to
  homescreen on iPhone).
- **`/worker`** (this `xero-invoice-worker` folder) — a Cloudflare Worker
  backend. Holds the Xero OAuth connection and does the actual API calls,
  since Xero's API can't be called safely from a browser.

## Key decisions (in order they were made)

1. **Native iOS app was ruled out** — no Xcode/Mac dev setup available.
   Went with a mobile web app instead.
2. **Invoice line format**: code, description, qty, unit price, GST, line
   total — matches Xero's own line item fields.
3. **Fuel Adjustment Factor**: a % of each line's total, but shown as **its
   own separate invoice line** (not folded into the product line), so it's
   visible as a distinct charge.
4. **CSV export was the first version** (Xero's Bulk Invoice Import format)
   — still in the app as a fallback (`Export CSV` button) if the live Xero
   connection is ever down.
5. **Direct Xero API push was added next** — creates the invoice as
   `Status: DRAFT`, never auto-authorised. Someone always reviews before it
   goes out.
6. **Customer matching**: the app pulls the real Xero customer list via
   `GET /contacts` and autocompletes against it, linking by actual
   `ContactID` — not free-typed name — so typos don't create duplicate
   Xero customers. Shows a ✓/⚠ match badge; unmatched names prompt a
   confirmation before sending.
7. **Due date default**: 20th of the month *following* the invoice date
   (standard NZ trade terms), recalculated automatically if the invoice
   date changes.
8. **Invoice grouping — this evolved twice, current behaviour is the third
   version**:
   - v1: every submission created a brand new Xero invoice.
   - v2: grouped by calendar week (Mon–Sun) per customer — rejected.
   - **v3 (current)**: grouped by an **Order # field** the user types in the
     app. That value is written into Xero's **Reference** field. Sending more
     lines under the same order number + customer appends to that invoice
     (as long as it's still a Xero draft); a new order number starts a fresh
     invoice. No cron, no scheduled job — it's purely keyed off what the
     user types, tracked in Cloudflare KV (`open_invoices` key). Order # is
     required before sending to Xero.
9. **Email summary**: after each successful Xero push, the worker emails a
   full summary (customer, order #, dates, all lines, subtotal/GST/total) to
   a company inbox via Resend. Optional — app still works if Resend secrets
   aren't set, just skips the email.
10. **Company rename mid-project**: "Longburn Shingle Company" /
    `longburnshingle.co.nz` → **"Longburn Industries Ltd"** /
    `longburnindustries.co.nz`. All app text, worker name, and docs were
    updated to match — if you spot a stray "Shingle" reference anywhere,
    it's a leftover that should be fixed.

## Accounts already in hand (as of this chat)

- **GitHub** — for version control / triggering Vercel deploys
- **Vercel** — chosen to host the app (`/app` → static site, auto-deploys
  on push to the connected GitHub repo)
- **Cloudflare** — hosts the worker (`wrangler deploy`, not git-triggered —
  has to be run manually or wired into CI separately)
- **Resend** — email summaries
- **Railway** — has an account but it's **not used** in this project; the
  worker is Cloudflare-specific and there was no reason to move it

## Domain plan (not yet done as of this chat)

- Owns `longburnindustries.co.nz`, DNS currently managed via Crazy Domains
  (was `longburnshingle.co.nz`'s registrar — same account presumably now
  covers the new domain, worth confirming)
- Target: **`invoices.longburnindustries.co.nz`** → CNAME → Vercel, pointing
  at the app
- Optional, not requested yet but mentioned as possible: a subdomain for the
  worker too (e.g. `xero-api.longburnindustries.co.nz`) via Cloudflare's
  custom domain feature — the default `workers.dev` URL is fine if this
  isn't a priority

## What's actually been deployed so far

**Nothing yet**, as of this conversation. Worker code and app code exist as
files but:
- Cloudflare Worker has not been `wrangler deploy`'d
- Xero developer app has not been registered
- GitHub repo has not been created
- Vercel project has not been connected
- DNS records have not been added

## Immediate next steps, roughly in order

1. Register Xero developer app → get client ID/secret
2. `wrangler` setup: KV namespace, secrets, `wrangler deploy`
3. Visit `/connect` once to authorise the Xero connection
4. Set up Resend (optional) for email summaries
5. Push code to a new GitHub repo
6. Connect that repo to Vercel, deploy `/app`
7. Add `invoices.longburnindustries.co.nz` as a custom domain in Vercel,
   then add the CNAME record in Crazy Domains DNS
8. Test end-to-end: build a real invoice in the app, confirm it lands as a
   draft in Xero with the right Reference number and the email arrives

The worker's own `README.md` has the exact commands for steps 1–4 — follow
it directly rather than re-deriving the setup.
