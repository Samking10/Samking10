# QuoteBack

Estimate follow-up for owner-operated residential painting contractors.

> Follow up on every estimate, keep interested customers from slipping away, and see which conversations lead to booked jobs.

A contractor adds the estimates they've sent (typed in or pasted from a spreadsheet). QuoteBack sends a short series of personal follow-up emails from their business name, during their business hours. It stops as soon as the customer replies, taps a response button, opts out, or the contractor marks the job booked or lost. Replies go straight to the contractor's inbox, and a results page shows which estimates turned into booked jobs.

Deliberately **not** a CRM. There are no contacts, companies, pipelines, tasks, SMS, or multiple users per account. One business, one follow-up sequence, estimates in and booked jobs out.

---

## Run it locally (5 minutes)

Requires Node.js 22.9 or newer.

```bash
cd quoteback
npm install
npm run demo        # optional: creates a demo account with 40 days of history
npm run dev         # http://localhost:3000
```

Demo login: `demo@quoteback.test` / `demo-password`. To see the admin page too, start with `ADMIN_EMAILS=demo@quoteback.test npm run dev`.

By default no email leaves your computer (`EMAIL_TRANSPORT=log`). Every email QuoteBack would send is shown at **/dev/outbox**.

```bash
npm test            # 27 tests covering scheduling, replies, billing webhooks, login and CSV import
```

---

## How follow-ups behave

These rules are what makes the product trustworthy. Each one has a test in `test/scheduler.test.js`.

| Rule | Why |
|---|---|
| Steps go out at *estimate date + N days*, moved to the next allowed time inside the contractor's sending days and hours, in their time zone (DST-safe). | No 11 PM or Sunday emails. |
| A reply by email, a tap on "ready to schedule / have a question / not now / no thanks", an unsubscribe, a bounce, or any status change by the contractor **cancels all remaining emails at once**. | The most important behavior: never chase someone who already answered. |
| Out-of-office auto-replies are logged but don't stop the sequence. | They aren't real answers. |
| Overdue steps never go out in a burst. If an estimate is old, or sending was on hold, the sequence starts now and keeps its original spacing. | Customers get one email at a time. |
| The same email address is never emailed twice within 20 hours (`MIN_HOURS_BETWEEN_EMAILS`). | Covers two estimates for the same customer. |
| Each step can only be sent once (enforced by a database constraint and an atomic "claim" before sending). | No duplicates, even if two scheduler processes run. |
| Temporary provider errors retry after 10 min, 40 min and 2 h 40 min. A permanent error (invalid address) marks the estimate "Bad email" and alerts the contractor. | Reliable without spamming. |
| If the server crashes mid-send, that email is marked *failed* with a Retry button rather than resent automatically. | We can't know if it went out, and a duplicate is worse than a delay. |
| Customer links (`/r/…`, `/u/…`) never change anything on a plain page open; only a button press does. | Corporate email scanners open every link automatically. |
| Opted-out addresses are remembered per business, so a new estimate to them sends nothing. | Legal (CAN-SPAM) and decent. |
| Sending only happens while the subscription is active, trialing, or in payment retry (`past_due`). Contractors can set everything up first and send themselves tests. | Clear upgrade moment. |

Wording edits apply to every email not yet sent. Timing edits apply to estimates added afterwards. Changing sending hours re-aligns already-scheduled emails.

---

## Going live checklist

Plan on an afternoon. Do the steps in order.

### 1. Domain (≈ $12/year)
Buy a domain (e.g. `getquoteback.com`). You'll use three names on it:
- `app.yourdomain.com`: the web app
- `mail.yourdomain.com`: sends follow-ups (`FROM_EMAIL=followups@mail.yourdomain.com`)
- `reply.yourdomain.com`: receives customer replies (`INBOUND_DOMAIN`)

### 2. Hosting on Render (≈ $7–8/month)
1. Push this repo to GitHub.
2. On render.com: **New → Blueprint** and pick the repo. It reads `render.yaml` at the repo root and creates a Starter web service with a 1 GB persistent disk for the database.
3. Fill in the env vars it asks for. `BASE_URL=https://app.yourdomain.com`, and `ADMIN_EMAILS` should be the email you'll sign up with.
4. Add `app.yourdomain.com` as a custom domain in Render and create the CNAME record it shows.
5. Sign up in the app with your admin email and open `/admin`.

Any host that runs a Docker container with a persistent disk works too (Fly.io, Railway, a $5 VPS). The `Dockerfile` is in this folder. **Run exactly one instance**; SQLite lives on one disk.

### 3. Email with Postmark (≈ $15–18/month)
1. Create a Postmark account and a server. Inbound processing needs Postmark's **Pro plan or higher** (check their pricing page).
2. **Sender:** add `mail.yourdomain.com` under Sender Signatures → Domains and create the DKIM and Return-Path DNS records. Copy the Server API token into `POSTMARK_SERVER_TOKEN`, then set `EMAIL_TRANSPORT=postmark` and `FROM_EMAIL`.
3. **Reply detection:** in the server's *Default Inbound Stream*:
   - add an MX record: `reply.yourdomain.com` → `inbound.postmarkapp.com` (priority 10)
   - set the inbound domain to `reply.yourdomain.com`
   - set the webhook URL to `https://postmark:<INBOUND_WEBHOOK_SECRET>@app.yourdomain.com/webhooks/postmark/inbound`
   - set `INBOUND_DOMAIN=reply.yourdomain.com` in Render
4. **Bounces:** in the outbound stream → Webhooks, add `https://postmark:<INBOUND_WEBHOOK_SECRET>@app.yourdomain.com/webhooks/postmark/bounce` with *Bounce* and *Spam Complaint* ticked.
5. Test it: in the app, use **Follow-ups → Send me a test**, then reply to one of the test emails from another address. The reply should be forwarded to you.

Without step 3, follow-ups still work, but replies go straight to the contractor and QuoteBack can't see them. The app then shows a warning asking them to mark replies by hand.

Resend (`EMAIL_TRANSPORT=resend`) is supported for sending only. Reply detection and bounce handling use Postmark's webhook format.

### 4. Payments
Start with `BILLING_MODE=manual`: send your first customers a Stripe Payment Link or invoice, then set their account to `active` in `/admin`. Switch to automatic billing once you have a few customers:

1. In Stripe, copy your secret key into `STRIPE_SECRET_KEY`.
2. Developers → Webhooks → add endpoint `https://app.yourdomain.com/webhooks/stripe` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Settings → Billing → Customer portal → save the default settings once (this enables "Manage card / cancel").
4. Set `BILLING_MODE=stripe`.

You don't need to create products or prices in Stripe. Checkout uses the amounts from your config.

### 5. Monitoring and backups (free)
- Add a free uptime monitor (e.g. UptimeRobot) on `https://app.yourdomain.com/healthz`. It returns 503 if the scheduler hasn't run in 10 minutes, so you hear about stuck emails before customers do.
- Render snapshots the disk daily. Also click **Download database backup** on `/admin` once a week and keep the file somewhere safe.

### Approximate monthly cost
| Item | Cost |
|---|---|
| Render Starter + 1 GB disk | ~$7.25 |
| Postmark (10k emails, with inbound) | ~$16.50 |
| Domain | ~$1 |
| **Total fixed** | **≈ $25/month** |
| Stripe | 2.9% + 30¢ per charge (≈ $9 on $299) |

11 customers × 4 follow-ups × ~60 new estimates/month ≈ 2,600 emails, well within 10k. Prices change, so check the providers' pricing pages.

---

## Configuration

All settings are environment variables (see `.env.example`). Pricing lives only in config and is read everywhere: landing page, billing page, Stripe Checkout and plan limits.

| Variable | Default | Meaning |
|---|---|---|
| `PLAN_PRICE_CENTS` | `29900` | Monthly price |
| `ONBOARDING_FEE_CENTS` / `ONBOARDING_FEE_ENABLED` | `29900` / `true` | Optional one-time setup fee offered at checkout |
| `MAX_ACTIVE_ESTIMATES` | `250` | Estimates being followed up (or paused) at once |
| `MAX_LOCATIONS` | `1` | Shown on pricing (one account = one location) |
| `TRIAL_DAYS` | `0` | Free days of sending after signup without a card |
| `BILLING_MODE` | `manual` | `manual` or `stripe` |
| `EMAIL_TRANSPORT` | `log` | `log`, `postmark` or `resend` |
| `INBOUND_DOMAIN` | empty | Turns on reply detection |
| `MIN_HOURS_BETWEEN_EMAILS` | `20` | Minimum gap between emails to one address |
| `SCHEDULER_ENABLED` | `true` | Run the scheduler inside the web process |

If your host prefers cron over a long-running process, set `SCHEDULER_ENABLED=false` and run `npm run tick` every few minutes.

---

## Running the business

**Onboarding a contractor (about 20 minutes on a call):**
1. They sign up. The dashboard shows a 4-step checklist.
2. Fill in business address and phone (Settings). The address is legally required in each email's footer.
3. Read the 4 default emails together and adjust the wording to sound like them. Click **Send me a test**.
4. Export their open estimates from their estimating tool or spreadsheet and paste them into **Import**. The preview flags bad rows and duplicates before anything is created.
5. Activate billing. Follow-ups start within a minute.

**Your weekly 10-minute check (`/admin`):**
- *Emails overdue by 2h+* should be 0, and *Since last scheduler run* should be under a minute or two.
- A *Failed* count above zero means look at that account (usually a typo'd customer email).
- *Last estimate added* older than ~2 weeks means the customer isn't using it and may cancel. Check in.

**Showing value:** the **Results** page (printable) shows follow-ups sent, customers who responded after a follow-up, and jobs booked after a follow-up with their value, next to what QuoteBack cost. It is honestly labeled "after a follow-up", not "caused by". Contractors must mark jobs **Booked** for this to count. Remind them on onboarding calls.

**Common support questions:**
- *"A customer replied but QuoteBack didn't notice."* They probably replied to the contractor's original estimate email, not to a follow-up. Mark the estimate "Customer replied" and the emails stop.
- *"I want to stop everything while I'm on vacation."* Settings → Pause all follow-ups.
- *"Wrong email address."* Open the estimate → Edit details. Fixing a bounced address restarts follow-ups automatically.
- *Forgot password:* self-serve reset link on the login page.

---

## Code map

```
src/
  config.js            env vars + pricing (single source of truth)
  db.js                SQLite schema and migrations
  time.js              time zones, sending windows
  scheduler.js         finds due follow-ups and sends them safely
  services/
    estimates.js       estimate lifecycle, status changes, limits
    customer.js        replies, response buttons, unsubscribes, bounces
    stats.js           results and value numbers
    billing.js         Stripe Checkout, portal and webhooks
    accounts.js        signup, settings, sequence editing, password reset
    notify.js          alerts to the contractor
  email/               message composition and providers (Postmark, Resend, log)
  routes/              web pages (public, app, account, admin, webhooks)
  views/               escaped HTML templating and layout
public/                CSS + small optional JS
scripts/               tick (cron), backup, demo data
test/                  node:test suites
```

Two runtime dependencies (`express`, `better-sqlite3`). No front-end build step and no SDKs to keep updated.

## Known limits and next steps (not built on purpose)
- One login per business. Add a `users` invite flow if contractors ask for an office manager seat.
- Email only. SMS follow-up is the most likely upsell, but it adds carrier registration (10DLC) and per-message cost.
- No email verification at signup. Fine while you onboard each customer personally.
- All contractors send from your shared `mail.` domain, so deliverability is pooled. Watch Postmark's bounce and spam rates. Per-contractor custom sending domains are a later upgrade.
