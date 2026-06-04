# Before You Sign — Server Deployment Guide

This guide covers the complete deployment lifecycle for the `beforeyousign-server` backend,
including local development, Render hosting, database migrations, Apple In-App Purchase
configuration, EAS mobile build integration, sandbox testing, and rollback procedures.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Local Development Setup](#2-local-development-setup)
3. [Environment Variables](#3-environment-variables)
4. [Database Migrations](#4-database-migrations)
5. [Apple Subscription Configuration](#5-apple-subscription-configuration)
6. [EAS Build Process](#6-eas-build-process)
7. [Sandbox Testing](#7-sandbox-testing)
8. [Render Deployment](#8-render-deployment)
9. [Production Deployment Checklist](#9-production-deployment-checklist)
10. [Rollback Procedures](#10-rollback-procedures)
11. [Subscription Verification Flow](#11-subscription-verification-flow)
12. [Subscription State Machine](#12-subscription-state-machine)
13. [Premium User Lifecycle](#13-premium-user-lifecycle)
14. [Restore Purchases Flow](#14-restore-purchases-flow)
15. [Failure Scenarios](#15-failure-scenarios)
16. [Phase 1 vs Phase 2 Responsibilities](#16-phase-1-vs-phase-2-responsibilities)
17. [Troubleshooting Guide](#17-troubleshooting-guide)

---

## 1. Architecture Overview

```
iOS App (StoreKit 2)
        │
        │  HTTPS
        ▼
beforeyousign-server  (Node.js / Express — hosted on Render)
        │
        ├── GET  /health
        ├── POST /ocr                          OpenAI Vision
        ├── GET  /api/subscription/status      Postgres read
        ├── POST /api/subscription/verify      Apple JWS → Postgres upsert
        └── POST /api/subscription/restore     Apple JWS → Postgres upsert

        │
        ├── Postgres (Render managed or external)
        └── Apple App Store Server API (root CA fetch only — no server-to-server calls in Phase 1)
```

**Key files:**

| File | Purpose |
|------|---------|
| `index.js` | Entry point. Creates Express app, registers middleware and routes. |
| `db.js` | Shared `pg.Pool` instance. |
| `routes/subscription.js` | All three subscription endpoints. |
| `001_users_table.sql` | Phase 1 database migration. |

---

## 2. Local Development Setup

### Prerequisites

- Node.js 18 or later
- npm
- A running Postgres instance (local or remote)

### Steps

```bash
# 1. Clone the repository
git clone <repo-url>
cd beforeyousign-server

# 2. Install dependencies
npm install

# 3. Create your local environment file
cp .env .env.local    # then edit .env.local with real values
# (or edit .env directly — it is gitignored)

# 4. Run the database migration (see Section 4)

# 5. Start the server
node index.js
```

The server starts on port `3001` by default. To use a different port:

```bash
PORT=4000 node index.js
```

### Verify the server is running

```bash
curl http://localhost:3001/health
# → {"ok":true}
```

---

## 3. Environment Variables

All variables are loaded from `.env` via `dotenv` at startup.

### Required in all environments

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for `/ocr`. |
| `DATABASE_URL` | Full Postgres connection string. Example: `postgres://user:pass@host:5432/dbname` |
| `APPLE_BUNDLE_ID` | iOS app bundle identifier. Example: `com.yourcompany.beforeyousign` |
| `APPLE_APP_ID` | Numeric App Store app ID from App Store Connect. Required for production Apple verification. |

### Controls Apple verification environment

| Variable | Values | Effect |
|----------|--------|--------|
| `NODE_ENV` | `production` | Directs `SignedDataVerifier` to Apple's **production** certificate chain. Sandbox transactions will be rejected. |
| `NODE_ENV` | anything else | Directs `SignedDataVerifier` to Apple's **sandbox** certificate chain. |

> **Known risk:** `NODE_ENV` controls both Node/Express optimizations and Apple's verification
> environment. A staging Render service running `NODE_ENV=production` will reject all Sandbox
> StoreKit transactions. If you run a staging environment, set `NODE_ENV` to something other than
> `production` on that service, or be aware that Apple verification will use the production chain.
> An explicit `APPLE_ENVIRONMENT` variable (decoupled from `NODE_ENV`) has been identified as the
> safer long-term configuration and is planned.

### Optional

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port. Defaults to `3001`. Render sets this automatically. |

### Local `.env` example

```
OPENAI_API_KEY=sk-...
DATABASE_URL=postgres://postgres:password@localhost:5432/beforeyousign
APPLE_BUNDLE_ID=com.yourcompany.beforeyousign
APPLE_APP_ID=1234567890
NODE_ENV=development
```

---

## 4. Database Migrations

### Migration: `001_users_table.sql`

This is the only migration required for Phase 1. It creates the `users` table that stores
anonymous user subscription state.

**Run once before the first deployment:**

```bash
psql $DATABASE_URL -f 001_users_table.sql
```

Or paste the contents directly into your Postgres client:

```sql
CREATE TABLE IF NOT EXISTS users (
  id                            UUID          PRIMARY KEY,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  subscription_status           TEXT          NOT NULL DEFAULT 'none'
                                             CHECK (subscription_status IN (
                                               'none', 'active', 'expired',
                                               'grace', 'billing_retry'
                                             )),
  subscription_product_id       TEXT,
  subscription_expires_at       TIMESTAMPTZ,
  apple_original_transaction_id TEXT          UNIQUE,
  last_verified_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_apple_otid
  ON users (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;
```

`CREATE TABLE IF NOT EXISTS` makes this safe to run more than once.

### Verifying the migration

```bash
psql $DATABASE_URL -c "\d users"
```

You should see all seven columns (`id`, `created_at`, `subscription_status`,
`subscription_product_id`, `subscription_expires_at`, `apple_original_transaction_id`,
`last_verified_at`) and the index on `apple_original_transaction_id`.

---

## 5. Apple Subscription Configuration

### What you need from App Store Connect

| Item | Where to find it | Maps to env var |
|------|-----------------|-----------------|
| Bundle ID | App Store Connect → App → General → Bundle ID | `APPLE_BUNDLE_ID` |
| App ID (numeric) | App Store Connect → App → General → Apple ID | `APPLE_APP_ID` |

### How Apple verification works in Phase 1

The server does **not** call Apple's App Store Server API on every request.

- `/status` — reads only from Postgres. No Apple call.
- `/verify` and `/restore` — receive StoreKit 2 signed transactions (JWS strings) from the iOS app
  and verify them locally using `@apple/app-store-server-library` and Apple's public root
  certificates. The root certificates are fetched from Apple's CDN on the first verification
  request after a cold start and cached in memory for the lifetime of the process.

### Apple root certificate URLs (fetched automatically)

```
https://www.apple.com/appleca/AppleIncRootCertificate.cer
https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
```

The Render server must be able to reach `apple.com` over HTTPS. No additional firewall rules are
required.

### StoreKit 2 transaction types handled

The server processes `Auto-Renewable Subscription` transaction types. Non-subscription purchases
are accepted as a fallback if no subscription transactions are present. The best entitlement is
selected by latest `expiresDate`.

### Subscription status values

| Value | Meaning |
|-------|---------|
| `none` | No row exists for this user (new or never purchased) |
| `active` | Subscription is current |
| `expired` | Subscription has lapsed or was revoked |
| `grace` | In billing grace period (set by webhook in Phase 2) |
| `billing_retry` | In billing retry period (set by webhook in Phase 2) |

`isPremium` is `true` when `subscriptionStatus` is `active` or `grace`.

---

## 6. EAS Build Process

EAS (Expo Application Services) builds the iOS binary. The server-side requirement is simply that
the iOS app points to the correct server URL.

### Server URL configuration

The iOS app must send requests to the deployed Render URL. Set the server base URL as an
environment variable in your Expo project before building:

**For development builds (pointing to local server):**
```
EXPO_PUBLIC_API_URL=http://localhost:3001
```

**For production builds:**
```
EXPO_PUBLIC_API_URL=https://your-service.onrender.com
```

### Building for TestFlight (sandbox testing)

```bash
eas build --platform ios --profile preview
```

### Building for App Store (production)

```bash
eas build --platform ios --profile production
```

### Required headers the iOS app must send

Every subscription API call must include:

```
X-User-Id: <anonymous-uuid>        # stable, device-generated UUID
Content-Type: application/json     # for POST endpoints
```

---

## 7. Sandbox Testing

### Setting up a Sandbox Apple ID

1. In App Store Connect → Users and Access → Sandbox Testers, create a sandbox tester account.
2. On your test device: Settings → App Store → sign out of your real Apple ID → sign in with the
   sandbox tester account, **or** leave your real account signed in and let StoreKit prompt for
   sandbox credentials during a purchase (iOS handles this automatically in development builds).

### Server configuration for sandbox testing

- `NODE_ENV` must **not** be `production` on the server you are testing against.
- The server will use `Environment.SANDBOX` for `SignedDataVerifier`, which accepts sandbox JWS
  tokens and rejects production ones.

### Manual endpoint tests

**Check status for a new user (expect free defaults):**
```bash
curl -s https://your-server/api/subscription/status \
  -H "X-User-Id: 00000000-0000-0000-0000-000000000001" | jq
```
Expected response:
```json
{
  "subscriptionStatus": "none",
  "isPremium": false,
  "productId": null,
  "expiresAt": null,
  "lastVerifiedAt": null
}
```

**Missing header validation (expect 400):**
```bash
curl -s https://your-server/api/subscription/status | jq
```

**Empty transactions (expect 400):**
```bash
curl -s -X POST https://your-server/api/subscription/verify \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 00000000-0000-0000-0000-000000000001" \
  -d '{"signedTransactions":[]}' | jq
```

**Health check:**
```bash
curl -s https://your-server/health | jq
```

### Full verify/restore test

A full test of `/verify` and `/restore` requires real StoreKit 2 signed transaction strings
generated from a Sandbox purchase on a physical device or Simulator. These JWS strings are
obtained in the iOS app from `Transaction.currentEntitlements` or `Transaction.all` and forwarded
to the server in the `signedTransactions` array.

---

## 8. Render Deployment

### Service type

**Web Service** — not a static site or background worker.

### Runtime settings

| Setting | Value |
|---------|-------|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `node index.js` |
| Node version | 18 or later |

### Environment variables on Render

In Render Dashboard → your service → Environment, add:

| Key | Value |
|-----|-------|
| `OPENAI_API_KEY` | Your OpenAI key |
| `DATABASE_URL` | Render internal DB URL (see below) or external connection string |
| `APPLE_BUNDLE_ID` | `com.yourcompany.beforeyousign` |
| `APPLE_APP_ID` | Numeric App Store app ID |
| `NODE_ENV` | `production` |

Render sets `PORT` automatically. Do not set it manually.

### Postgres on Render

If using a Render-managed Postgres database:

1. Create a Postgres service in Render.
2. Copy the **Internal Database URL** (not the external one) into `DATABASE_URL` on the web
   service. Internal URLs avoid egress fees and latency.

### Running the migration on Render

Render does not run migrations automatically. After the database is created and before the first
deploy goes live:

**Option A — Render Shell (if available on your plan):**
```bash
psql $DATABASE_URL -f 001_users_table.sql
```

**Option B — external psql using the External Database URL:**
```bash
psql "postgres://user:pass@external-host:5432/dbname" -f 001_users_table.sql
```

### Deploy

Render auto-deploys on push to the connected branch. To trigger a manual deploy:

```bash
# Via Render dashboard: Manual Deploy button
# or push a commit to the connected branch
git push origin main
```

---

## 9. Production Deployment Checklist

Complete every item in order before considering a deployment production-ready.

### Database
- [ ] `001_users_table.sql` has been run against the production Postgres instance
- [ ] `\d users` confirms all seven columns and the index exist
- [ ] `DATABASE_URL` on Render points to the internal Postgres URL

### Environment variables
- [ ] `OPENAI_API_KEY` is set and valid
- [ ] `DATABASE_URL` is set
- [ ] `APPLE_BUNDLE_ID` matches the bundle ID in App Store Connect exactly
- [ ] `APPLE_APP_ID` matches the numeric Apple ID in App Store Connect exactly
- [ ] `NODE_ENV` is set to `production`

### Apple configuration
- [ ] App Store Connect has at least one Auto-Renewable Subscription product configured
- [ ] Subscription product is approved or in review (not in draft)
- [ ] The App Store app ID and bundle ID have been cross-checked against App Store Connect

### Server health
- [ ] `GET /health` returns `{"ok":true}` on the production URL
- [ ] `GET /api/subscription/status` with a valid UUID header returns the default free response
- [ ] Render deploy logs show no startup errors

### iOS build
- [ ] `EXPO_PUBLIC_API_URL` (or equivalent) in the production EAS build points to the production
  Render URL
- [ ] Production EAS build submitted to App Store Review or TestFlight

### Smoke test after deploy
- [ ] `/health` responds within 2 seconds
- [ ] `/api/subscription/status` with a known user ID returns the correct stored status
- [ ] A real Sandbox purchase flow completes end-to-end (device → `/verify` → Postgres row created)

---

## 10. Rollback Procedures

### Rolling back the server

Render keeps previous deploys available. To roll back:

1. Render Dashboard → your service → **Deploys** tab.
2. Find the last known-good deploy.
3. Click **Redeploy** on that entry.

The previous `node index.js` build will be restarted with no code changes required.

### Rolling back a database migration

`001_users_table.sql` uses `CREATE TABLE IF NOT EXISTS`, which is non-destructive. If you need to
remove the table entirely (e.g. to start fresh in development):

```sql
DROP TABLE IF EXISTS users;
```

> **Do not run this on production.** There is no automated rollback for a dropped table without a
> backup. Take a Render Postgres snapshot before any destructive schema change.

### Taking a Postgres snapshot before a migration

In Render Dashboard → your Postgres service → **Backups**, trigger a manual backup before running
any migration. Render also takes automatic daily backups on paid plans.

### Emergency: server failing to start after a deploy

1. Check Render deploy logs for the specific error.
2. If the error is a missing environment variable, add it in Render → Environment → redeploy.
3. If the error is a code regression, roll back to the previous deploy (see above).
4. If the database is unreachable, check `DATABASE_URL` and Render Postgres service status.

### Emergency: all `/verify` and `/restore` calls returning 400

The most common cause is an Apple environment mismatch. Verify:

- `NODE_ENV` on the server matches the StoreKit environment the iOS app is using.
  (`production` server + sandbox transactions = all verifications rejected.)
- The signed transactions being sent are from the correct Apple environment.
- Apple's root CA URLs are reachable from the Render server (outbound HTTPS to `apple.com`).

To confirm the server can reach Apple's CDN:

```bash
# From Render Shell or a local machine pointing at the same network
curl -I https://www.apple.com/appleca/AppleIncRootCertificate.cer
# Expect: HTTP/2 200
```

---

## 11. Subscription Verification Flow

This section documents the complete Phase 1 subscription lifecycle from the perspective of the
server contract. iOS implementation details (SwiftUI, StoreKit API calls, `SubscriptionContext`
internals) are described at the level of what the server requires — not as prescriptive iOS code.

---

### 11.1 Anonymous Device ID

The server identifies users by a UUID passed in the `X-User-Id` request header. The server does
not generate, validate, or authenticate this ID — it trusts whatever UUID the client sends.

**Server contract:**
- The UUID must be stable across app launches for the same device/user.
- It must be a valid UUID string (any version).
- The server stores it as the primary key in the `users` table.

**Expected iOS behaviour:**
- Generate a UUID once on first launch and persist it to device storage (e.g. `UserDefaults` or
  Keychain).
- Read the same UUID on every subsequent launch.
- Send it as `X-User-Id` on every subscription API request.

> **Phase 1 assumption:** The ID is device-scoped. There is no account system and no way to
> transfer a subscription to a new device in Phase 1. This is a known limitation; multi-device
> support requires user accounts and is Phase 2 scope.

---

### 11.2 Sequence Diagrams

#### New Purchase Flow

```
iOS App                         beforeyousign-server          Postgres         Apple CDN
   │                                     │                       │                  │
   │  (first launch)                     │                       │                  │
   │  generate UUID → persist locally    │                       │                  │
   │                                     │                       │                  │
   │  GET /api/subscription/status       │                       │                  │
   │  X-User-Id: <uuid>  ───────────────>│                       │                  │
   │                                     │  SELECT * FROM users  │                  │
   │                                     │  WHERE id = $1 ──────>│                  │
   │                                     │  (no row found)       │                  │
   │<── 200 { status:"none", isPremium:false, ... } ────────────│                  │
   │                                     │                       │                  │
   │  (user taps Subscribe)              │                       │                  │
   │  StoreKit purchase sheet            │                       │                  │
   │  ← Apple handles payment ────────────────────────────────────────────────────>│
   │                                     │                       │                  │
   │  Transaction.currentEntitlements    │                       │                  │
   │  → [JWSTransaction string]          │                       │                  │
   │                                     │                       │                  │
   │  POST /api/subscription/verify      │                       │                  │
   │  X-User-Id: <uuid>                  │                       │                  │
   │  { signedTransactions: ["eyJ..."] } │                       │                  │
   │  ──────────────────────────────────>│                       │                  │
   │                                     │  fetch root CAs ──────────────────────── >│
   │                                     │  (cached after first call)               │
   │                                     │<─────────────────────────────────────────│
   │                                     │                       │                  │
   │                                     │  SignedDataVerifier   │                  │
   │                                     │  .verifyAndDecodeTransaction()           │
   │                                     │  (local cryptographic verification)      │
   │                                     │                       │                  │
   │                                     │  INSERT INTO users    │                  │
   │                                     │  ON CONFLICT UPDATE ─>│                  │
   │                                     │                       │                  │
   │<── 200 { status:"active", isPremium:true, expiresAt:"...", ... } ─────────────│
   │                                     │                       │                  │
   │  SubscriptionContext refreshes      │                       │                  │
   │  → unlock premium UI                │                       │                  │
```

#### App Relaunch / Status Check Flow

```
iOS App                         beforeyousign-server          Postgres
   │                                     │                       │
   │  (app launch)                       │                       │
   │  read UUID from storage             │                       │
   │                                     │                       │
   │  GET /api/subscription/status       │                       │
   │  X-User-Id: <uuid>  ───────────────>│                       │
   │                                     │  SELECT * FROM users  │
   │                                     │  WHERE id = $1 ──────>│
   │                                     │<── row found ─────────│
   │<── 200 { status:"active", isPremium:true, ... } ────────────│
   │                                     │                       │
   │  SubscriptionContext sets isPremium │                       │
```

#### Restore Purchases Flow

```
iOS App                         beforeyousign-server          Postgres         Apple CDN
   │                                     │                       │                  │
   │  (user taps Restore Purchases)      │                       │                  │
   │  Transaction.all                    │                       │                  │
   │  → [JWSTransaction, ...]            │                       │                  │
   │  (all historical transactions)      │                       │                  │
   │                                     │                       │                  │
   │  POST /api/subscription/restore     │                       │                  │
   │  X-User-Id: <uuid>                  │                       │                  │
   │  { signedTransactions: ["eyJ...", "eyJ..."] }               │                  │
   │  ──────────────────────────────────>│                       │                  │
   │                                     │  (same verification   │                  │
   │                                     │   and upsert logic    │                  │
   │                                     │   as /verify)         │                  │
   │                                     │                       │                  │
   │<── 200 { status:"active"|"expired", isPremium:bool, ... } ──│                  │
   │                                     │                       │                  │
   │  SubscriptionContext refreshes      │                       │                  │
```

---

### 11.3 Request and Response Reference

#### `GET /api/subscription/status`

**Request:**
```http
GET /api/subscription/status HTTP/1.1
X-User-Id: 7f3a1c2d-4e5b-6f7a-8b9c-0d1e2f3a4b5c
```

**Response — user has never purchased:**
```json
{
  "subscriptionStatus": "none",
  "isPremium": false,
  "productId": null,
  "expiresAt": null,
  "lastVerifiedAt": null
}
```

**Response — active subscription:**
```json
{
  "subscriptionStatus": "active",
  "isPremium": true,
  "productId": "com.yourcompany.beforeyousign.premium.monthly",
  "expiresAt": "2026-07-03T00:00:00.000Z",
  "lastVerifiedAt": "2026-06-03T23:24:00.000Z"
}
```

**Response — lapsed subscription:**
```json
{
  "subscriptionStatus": "expired",
  "isPremium": false,
  "productId": "com.yourcompany.beforeyousign.premium.monthly",
  "expiresAt": "2026-05-01T00:00:00.000Z",
  "lastVerifiedAt": "2026-05-01T12:00:00.000Z"
}
```

---

#### `POST /api/subscription/verify`

**Request:**
```http
POST /api/subscription/verify HTTP/1.1
X-User-Id: 7f3a1c2d-4e5b-6f7a-8b9c-0d1e2f3a4b5c
Content-Type: application/json

{
  "signedTransactions": [
    "eyJhbGciOiJFUzI1NiIsIng1YyI6WyJNSUlC..."
  ]
}
```

**Response — success:**
```json
{
  "subscriptionStatus": "active",
  "isPremium": true,
  "productId": "com.yourcompany.beforeyousign.premium.monthly",
  "expiresAt": "2026-07-03T00:00:00.000Z",
  "lastVerifiedAt": "2026-06-03T23:24:00.000Z"
}
```

---

#### `POST /api/subscription/restore`

Identical request and response shape to `/verify`. Semantically distinct — the iOS app sends
`Transaction.all` (full history) rather than `Transaction.currentEntitlements` (active only).
The server applies the same verification and upsert logic regardless.

---

### 11.4 Internal Verification Logic

When `/verify` or `/restore` is called, `verifyAndUpsert()` executes these steps in order:

1. **Fetch Apple root CAs** — downloads three `.cer` files from `apple.com` if not already cached
   in memory. Cached for the lifetime of the server process.

2. **Create `SignedDataVerifier`** — instantiated with the root CAs, `APPLE_BUNDLE_ID`,
   `APPLE_APP_ID`, and the environment derived from `NODE_ENV`.

3. **Verify each signed transaction** — calls
   `verifier.verifyAndDecodeTransaction(signedTransaction)` for each JWS string. Invalid
   transactions (wrong environment, tampered, wrong bundle ID) are logged with `console.warn` and
   skipped. Valid payloads are collected.

4. **Select best entitlement** — filters for `Auto-Renewable Subscription` type first; falls back
   to all verified transactions if none are found. Sorts by `expiresDate` descending. The
   transaction with the latest expiry wins.

5. **Derive status** — from the winning transaction payload fields:
   - `revocationDate` present → `expired`
   - `expiresDate` absent → `active` (non-expiring purchase)
   - `expiresDate` > `Date.now()` → `active`
   - `expiresDate` ≤ `Date.now()` → `expired`

6. **Upsert `users` row** — `INSERT ... ON CONFLICT (id) DO UPDATE`. All five subscription fields
   are overwritten on conflict. `last_verified_at` is set to the server's current time.

7. **Return response** — the same shape as `/status`, built directly from the upserted values.

---

### 11.5 SubscriptionContext Refresh Behaviour

The server does not push updates to the iOS app. All state changes are pull-based in Phase 1.

**Expected iOS refresh points:**

| Trigger | Action |
|---------|--------|
| App launch / foreground | `GET /api/subscription/status` |
| After successful StoreKit purchase | `POST /api/subscription/verify` → update context |
| After tapping Restore Purchases | `POST /api/subscription/restore` → update context |
| Paywall dismissed without purchase | No server call needed |

The `SubscriptionContext` should treat the server response as the source of truth for `isPremium`
and `subscriptionStatus`. Local StoreKit state should be used only to obtain signed transactions
to send to the server — not to gate UI directly.

> **Phase 1 limitation:** If a subscription renews, expires, or enters a grace period between app
> launches, the app will not know until the next foreground status check. Real-time status updates
> (via Apple server-to-server notifications) are Phase 2 scope.

---

### 11.6 Error Scenarios

#### Client errors (4xx)

| Scenario | HTTP | Response body |
|----------|------|---------------|
| `X-User-Id` header missing | 400 | `{ "error": "X-User-Id header is required." }` |
| `signedTransactions` missing or empty array | 400 | `{ "error": "signedTransactions must be a non-empty array." }` |
| All transactions fail JWS verification | 400 | `{ "error": "No valid signed transactions could be verified." }` |

The third case — all transactions rejected — most commonly means an Apple environment mismatch:
the server is pointed at `Environment.PRODUCTION` but the iOS app sent Sandbox transactions, or
vice versa. See [Section 10](#10-rollback-procedures) for the diagnostic steps.

#### Server errors (5xx)

| Scenario | HTTP | Likely cause |
|----------|------|-------------|
| `{ "error": "Failed to retrieve subscription status." }` | 500 | Postgres unreachable or `DATABASE_URL` misconfigured |
| `{ "error": "Subscription verification failed." }` | 500 | Apple root CA fetch failed (network), Postgres write failed, or unexpected library error |
| `{ "error": "Subscription restore failed." }` | 500 | Same as above |

All 5xx errors are logged to `console.error` with the underlying message. Check Render logs for
the full stack trace.

---

### 11.7 Phase 1 vs Phase 2

| Capability | Phase 1 | Phase 2 |
|------------|---------|---------|
| Purchase verification | ✓ Local JWS verification via `SignedDataVerifier` | — |
| Restore purchases | ✓ Same JWS verification path | — |
| Status read from DB | ✓ `GET /status` reads `users` table | — |
| Status `active` / `expired` | ✓ Derived from JWS `expiresDate` | — |
| Status `grace` / `billing_retry` | ✗ Not reachable in Phase 1 | ✓ Set by Apple webhook notification |
| Real-time renewal detection | ✗ App must call `/status` on launch | ✓ Webhook updates DB immediately |
| Server-to-server Apple API calls | ✗ None | ✓ `getAllSubscriptionStatuses` for status reconciliation |
| Multi-device subscription transfer | ✗ UUID is device-scoped | ✓ Requires user accounts |
| Explicit `APPLE_ENVIRONMENT` variable | ✗ Inferred from `NODE_ENV` | ✓ Planned |

---

## 12. Subscription State Machine

### 12.1 States

The `subscription_status` column in the `users` table is constrained to exactly five values by a
`CHECK` constraint defined in `001_users_table.sql`.

| State | Meaning | `isPremium` |
|-------|---------|-------------|
| `none` | No row exists for this device UUID. User has never completed a verify or restore call. | `false` |
| `active` | Subscription is current. `expiresDate` is in the future and no `revocationDate` is present on the winning transaction. | `true` |
| `expired` | Subscription has lapsed (`expiresDate` is in the past) or was revoked by Apple. | `false` |
| `grace` | Billing failed but the user is in Apple's grace period and retains access. | `true` |
| `billing_retry` | Billing failed and the grace period has ended. Access is revoked while Apple retries payment. | `false` |

> **`none` as a virtual state:** When `GET /status` finds no row for the given UUID, the server
> returns `subscriptionStatus: "none"` without touching the database. No Phase 1 endpoint ever
> writes `none` to the table — `verify` and `restore` always produce either `active` or `expired`.

### 12.2 Transitions

```
              ┌──────────┐
              │   none   │  (no DB row — first launch)
              └──────────┘
                    │
                    │  POST /verify or /restore
                    │  (first successful call)
                    ▼
              ┌──────────┐   subscription lapses    ┌───────────┐
              │  active  │ ──────────────────────> │  expired  │
              │          │ <─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │           │
              └──────────┘  user re-subscribes,     └───────────┘
                    │       new transaction sent
                    │
            [Phase 2 only — webhook required for all transitions below]
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    ┌──────────┐       ┌──────────────────┐
    │  grace   │       │  billing_retry   │
    └──────────┘       └──────────────────┘
          │  billing           │  billing
          │  recovered         │  recovered
          └──────────┬─────────┘
                     ▼
               ┌──────────┐
               │  active  │
               └──────────┘
```

### 12.3 Transition Triggers

| From | To | Trigger | Phase |
|------|----|---------|-------|
| `none` | `active` | `/verify` or `/restore` — transaction `expiresDate > now`, no `revocationDate` | 1 |
| `none` | `expired` | `/verify` or `/restore` — transaction already lapsed at time of call | 1 |
| `active` | `active` | `/verify` or `/restore` — re-verification during active period | 1 |
| `active` | `expired` | `/verify` or `/restore` — subscription has since lapsed | 1 |
| `expired` | `active` | `/verify` or `/restore` — user re-subscribed, new active transaction sent | 1 |
| `expired` | `expired` | `/verify` or `/restore` — subscription still lapsed | 1 |
| `active` | `grace` | Apple webhook `DID_FAIL_TO_RENEW` with in-grace-period flag | 2 |
| `active` | `billing_retry` | Apple webhook `DID_FAIL_TO_RENEW` without grace period | 2 |
| `grace` | `active` | Apple webhook `DID_RENEW` after billing recovery | 2 |
| `billing_retry` | `active` | Apple webhook `DID_RENEW` after billing recovery | 2 |
| `grace` | `expired` | Apple webhook `EXPIRED` after grace period exhausted | 2 |
| `billing_retry` | `expired` | Apple webhook `EXPIRED` after retry period exhausted | 2 |

### 12.4 Status Derivation Logic (Phase 1)

The server derives status from the decoded JWS transaction payload without calling Apple's API.
Rules are evaluated in order on the winning transaction:

```
1. tx.revocationDate is set        →  "expired"
2. tx.expiresDate is absent        →  "active"   (non-expiring / lifetime purchase)
3. tx.expiresDate > Date.now()     →  "active"
4. tx.expiresDate <= Date.now()    →  "expired"
```

`grace` and `billing_retry` are not derivable from a JWS payload. They require Apple
server-to-server notification events and are Phase 2 scope.

---

## 13. Premium User Lifecycle

### 13.1 First Install — Free User

1. App installs on device. A stable UUID is generated and persisted locally.
2. App calls `GET /api/subscription/status` — no row exists, server returns
   `{ subscriptionStatus: "none", isPremium: false }`.
3. App shows free / paywall experience.

### 13.2 First Purchase

1. User taps Subscribe. StoreKit presents the Apple payment sheet.
2. On success, StoreKit delivers a signed transaction via `Transaction.currentEntitlements`.
3. App calls `POST /api/subscription/verify` with the JWS string.
4. Server verifies, derives `active`, upserts a row in `users`.
5. Server returns `{ subscriptionStatus: "active", isPremium: true, expiresAt: "...", ... }`.
6. `SubscriptionContext` sets `isPremium = true`. Premium UI unlocks.

### 13.3 Subsequent Launches — Active Subscription

1. App reads UUID from local storage.
2. App calls `GET /api/subscription/status` — row exists with `active`, server returns active response.
3. `SubscriptionContext` confirms `isPremium = true`. No purchase prompt shown.

> **Note on renewals:** The server is not notified when Apple renews a subscription automatically.
> `expiresAt` in the DB reflects the last JWS transaction the app sent to `/verify`. The row
> stays `active` between verify calls even if the actual renewal date has passed. This is an
> accepted Phase 1 trade-off.

### 13.4 Subscription Lapse

1. Auto-renewal fails and Apple exhausts its retry window, or the user cancels.
2. `expiresDate` passes.
3. **Before the next verify call:** server DB still shows `active` from the last verify.
4. On next app launch, `GET /status` returns stale `active`. The server cannot detect the lapse
   without a new verify call or a Phase 2 webhook.
5. When the iOS app calls `/verify` or `/restore` with the expired transaction, the server
   re-derives `expired` and updates the DB.
6. `SubscriptionContext` sets `isPremium = false`. Premium UI locks.

> **Phase 1 gap:** Stale `active` status can persist between app launches until the next
> verify/restore call. The Phase 2 webhook eliminates this gap.

### 13.5 Re-subscription

1. User re-subscribes via StoreKit. New signed transaction delivered.
2. App calls `POST /api/subscription/verify`.
3. Server derives `active`, upserts row — `expiresAt` and `apple_original_transaction_id` updated.
4. `SubscriptionContext` unlocks premium UI.

### 13.6 Reinstall on Same Device

- **UUID in Keychain (survives reinstall):** `GET /status` returns existing subscription state.
  No restore needed.
- **UUID in UserDefaults (lost on reinstall):** New UUID generated. `GET /status` returns `none`.
  User must tap Restore Purchases. The old UUID row in `users` becomes orphaned but causes no
  functional problem.

> **Recommendation:** Store the device UUID in Keychain. UserDefaults does not survive a reinstall
> and forces a restore flow every time.

### 13.7 New Device — Phase 1 Limitation

There is no mechanism to transfer subscription state between devices by UUID. A user on a new
device starts at `none` and must complete a Restore Purchases flow. Restore works correctly
because the JWS transactions from Apple are linked to the Apple ID, not the device. The two device
UUIDs will each hold their own `users` row.

---

## 14. Restore Purchases Flow

### 14.1 When Restore Is Needed

| Scenario | Restore required |
|----------|-----------------|
| Reinstall — UUID lost from UserDefaults | Yes |
| Reinstall — UUID preserved in Keychain | No — `/status` returns correct state |
| New device, same Apple ID | Yes |
| User never purchased | Restore returns `expired` (most recent transaction lapsed) or no further action |
| Active subscription, new device | Restore returns `active` |

### 14.2 How Restore Differs from Verify

| | `/verify` | `/restore` |
|-|-----------|------------|
| iOS sends | `Transaction.currentEntitlements` | `Transaction.all` |
| Transactions included | Active entitlements only | Full purchase history |
| Typical count | 1 | 1 to many |
| Server logic | Identical (`verifyAndUpsert`) | Identical (`verifyAndUpsert`) |
| Typical trigger | After new purchase | User-initiated restore action |

The server processes both through the same `verifyAndUpsert()` function. The difference is
entirely in what the iOS app chooses to send.

### 14.3 Best Entitlement Selection with Multiple Transactions

When `/restore` receives multiple JWS strings, the server:

1. Verifies each one individually. Invalid tokens are skipped silently with `console.warn`.
2. Filters to `Auto-Renewable Subscription` type; falls back to all types if none qualify.
3. Sorts remaining candidates by `expiresDate` descending.
4. Derives status from the winning (latest expiry) transaction.

**Example — active subscription, historical transactions included:**

| Transaction | `expiresDate` | Selected |
|-------------|--------------|----------|
| Original purchase | 2025-06-01 (past) | No |
| First renewal | 2025-12-01 (past) | No |
| Latest renewal | 2026-07-01 (future) | **Yes → `active`** |

**Example — cancelled subscription:**

| Transaction | `expiresDate` | Selected |
|-------------|--------------|----------|
| Original purchase | 2025-06-01 (past) | No |
| Last renewal | 2025-12-01 (past) | **Yes → `expired`** |

### 14.4 `apple_original_transaction_id` Uniqueness Constraint

The `users` table has a `UNIQUE` constraint on `apple_original_transaction_id`. The upsert in
`verifyAndUpsert()` targets conflict on `id` (the UUID primary key). This means:

- **Same UUID, re-verify:** updates the existing row cleanly.
- **New UUID, new subscription:** inserts a new row cleanly.
- **New UUID, same `apple_original_transaction_id` (restore to new device UUID):** the
  `ON CONFLICT (id)` insert path attempts to create a new row, but Postgres rejects it because
  `apple_original_transaction_id` is already held by a different UUID row — resulting in a 500.

This is a known Phase 1 limitation. See [Section 17.7](#177-apple_original_transaction_id-unique-constraint-violation) for the manual workaround.

---

## 15. Failure Scenarios

### 15.1 Client Errors (400)

#### Missing `X-User-Id` header

```json
{ "error": "X-User-Id header is required." }
```

**Cause:** The iOS app did not include `X-User-Id` in the request.
**Fix:** Confirm every subscription API call includes the header. Should never occur in a correct
iOS implementation.

---

#### Empty or missing `signedTransactions`

```json
{ "error": "signedTransactions must be a non-empty array." }
```

**Cause:** The request body was missing the field or contained an empty array.
**Fix:** Confirm the iOS app collects StoreKit transactions before calling the endpoint.
`Transaction.currentEntitlements` can return empty if the user has no active purchases — handle
this in the iOS app before making the network call.

---

#### All transactions fail JWS verification

```json
{ "error": "No valid signed transactions could be verified." }
```

**Most common cause:** Apple environment mismatch. The server is configured for one environment
and the iOS app sent transactions from the other. Each rejected transaction produces a
`console.warn` in the server logs with the library's rejection reason.

**Other causes:**
- `APPLE_BUNDLE_ID` does not match the bundle ID embedded in the JWS token (case-sensitive).
- `APPLE_APP_ID` is wrong or missing.
- JWS strings were truncated or malformed in transit.

See [Section 17.2](#172-verify-or-restore-returns-400-no-valid-transactions) for diagnostic steps.

---

### 15.2 Server Errors (500)

#### `/status` returns 500

**Cause:** Postgres `SELECT` threw an exception — unreachable database or wrong `DATABASE_URL`.

---

#### `/verify` or `/restore` returns 500

| Root cause | Signal in Render logs |
|------------|----------------------|
| Apple root CA fetch failed | Network / HTTPS error referencing `apple.com` |
| Postgres unique constraint violation | `duplicate key value violates unique constraint "users_apple_original_transaction_id_key"` |
| Postgres connection failed | `connection refused` or `ECONNREFUSED` |
| Unexpected library exception | Stack trace from `@apple/app-store-server-library` |

Check the `console.error` line in Render logs immediately following the failed request timestamp.

---

### 15.3 Silent / Unexpected Behaviours

#### `isPremium: true` after subscription expired

The DB row reflects the last verify/restore call. The subscription has since lapsed but no new
verify call has been made. Status check returns stale data. **Expected Phase 1 behaviour.**
The Phase 2 webhook eliminates this gap.

---

#### First verify/restore call after server start is slow

Apple root CAs are fetched from `apple.com` on the first call after a cold start. Cached in
memory for the lifetime of the process. **Expected — no action needed.**

---

#### Restore returns `expired` for an active subscriber

The subscriber's latest active transaction was not included in the `signedTransactions` array
sent by the iOS app. The server selected the most recent expired transaction as the winner.
**Fix:** Ensure the iOS app sends all transactions from `Transaction.all` without filtering.

---

## 16. Phase 1 vs Phase 2 Responsibilities

### 16.1 What Phase 1 Owns

- **JWS-based verification:** Cryptographically validates transactions using Apple's public root
  certificates via `@apple/app-store-server-library`. No Apple API credentials are required.
- **Durable subscription state:** `users` table stores status, product ID, expiry, and original
  transaction ID. Status reads are a single indexed Postgres query.
- **All client-initiated flows:** Purchase (`/verify`), restore (`/restore`), and status read
  (`/status`) are fully implemented.
- **Consistent `isPremium` logic:** Enforced uniformly across all endpoints via `buildResponse()`
  and `verifyAndUpsert()`. `active` and `grace` are premium; everything else is not.

### 16.2 Known Phase 1 Gaps

| Gap | User impact | Phase 1 workaround |
|-----|-------------|-------------------|
| No real-time renewal/expiry detection | Stale `active` status between launches | iOS app calls `/verify` on foreground in addition to `/status` |
| `grace` and `billing_retry` unreachable | Users in billing grace show incorrect status | None available in Phase 1 |
| Multi-device subscription not linked | New device UUID starts at `none` | User completes Restore Purchases |
| `apple_original_transaction_id` conflict on restore to new UUID | 500 on `/restore` for new-device restore | Manual DB row deletion (Section 17.7) |
| `NODE_ENV` controls Apple environment | Staging with `NODE_ENV=production` rejects Sandbox tokens | Set `NODE_ENV` to non-`production` on staging |

### 16.3 What Phase 2 Will Add

| Gap closed | Phase 2 mechanism |
|------------|------------------|
| Real-time renewal / expiry | `POST /api/subscription/webhook` consuming Apple `NOTIFICATIONS_V2` |
| `grace` status | Webhook `DID_FAIL_TO_RENEW` handler with in-grace-period detection |
| `billing_retry` status | Webhook `DID_FAIL_TO_RENEW` handler without grace period |
| Recovery from billing failure | Webhook `DID_RENEW` handler sets `active` |
| Proactive expiry marking | Webhook `EXPIRED` handler sets `expired` |
| Apple environment decoupling | Explicit `APPLE_ENVIRONMENT` env var replacing `NODE_ENV` inference |
| Multi-device / cross-device support | User accounts or `apple_original_transaction_id`-keyed upsert |

---

## 17. Troubleshooting Guide

Symptoms are ordered from most to least common in development and early production.

---

### 17.1 All Users Show as Free — Status Always Returns `none`

**Symptom:** `GET /status` returns `subscriptionStatus: "none"` for every user.

**Step 1 — Confirm the header is being sent:**
```bash
curl -v https://your-server/api/subscription/status \
  -H "X-User-Id: 00000000-0000-0000-0000-000000000001"
```
Check verbose output for `X-User-Id` in the outgoing request headers.

**Step 2 — Confirm the `users` table has rows:**
```sql
SELECT id, subscription_status, last_verified_at FROM users LIMIT 10;
```
An empty table means no successful `/verify` or `/restore` call has ever completed.

**Step 3 — Confirm UUID consistency:**
The UUID sent to `/status` must be byte-for-byte identical to the UUID sent during `/verify`.
A UUID stored in UserDefaults on one install and re-generated after reinstall is the most common
cause of a persistent `none` state for a user who has purchased.

---

### 17.2 `/verify` or `/restore` Returns 400 — No Valid Transactions

**Symptom:**
```json
{ "error": "No valid signed transactions could be verified." }
```

**Step 1 — Read Render logs** for `console.warn` lines. The library logs the rejection reason for
each skipped token (environment mismatch, bundle ID mismatch, etc.).

**Step 2 — Check Apple environment:**

| Server `NODE_ENV` | StoreKit environment | Outcome |
|-------------------|----------------------|---------|
| `production` | Sandbox | All tokens rejected |
| not `production` | Production | All tokens rejected |
| `production` | Production | Tokens accepted |
| not `production` | Sandbox | Tokens accepted |

**Step 3 — Verify `APPLE_BUNDLE_ID`:**
Must match the bundle ID in App Store Connect exactly, including case.

**Step 4 — Verify `APPLE_APP_ID`:**
Must be the numeric Apple ID (e.g. `1234567890`), not the bundle ID string.

**Step 5 — Confirm JWS strings are intact:**
Log the raw `signedTransactions` array on the iOS side before sending. JWS tokens begin with
`eyJ` and are typically 500–2000 characters. Confirm they are not being truncated.

---

### 17.3 `/verify` or `/restore` Returns 500

**Symptom:**
```json
{ "error": "Subscription verification failed." }
```

**Step 1 — Read Render logs** for the `console.error` output. The underlying error is always logged.

**Step 2 — Apple root CA fetch failure:**
```bash
curl -I https://www.apple.com/appleca/AppleIncRootCertificate.cer
# Expect: HTTP/2 200
```
If this fails, the Render server cannot reach `apple.com` for the initial root CA fetch.

**Step 3 — Postgres write failure:**
Look for `duplicate key`, `unique constraint`, or `connection refused` in the logs.
For the unique constraint scenario, see [Section 17.7](#177-apple_original_transaction_id-unique-constraint-violation).

---

### 17.4 `/status` Returns 500

**Symptom:**
```json
{ "error": "Failed to retrieve subscription status." }
```

**Step 1:** Confirm `DATABASE_URL` is set in Render → your service → Environment.

**Step 2:** Confirm the Postgres service is running in Render Dashboard (status: `Available`).

**Step 3:** Confirm the connection string format is correct:
```
postgres://user:password@host:port/dbname
```
If using Render's internal URL, both the web service and Postgres service must be in the same
Render region.

**Step 4:** Check Render logs for the raw Postgres error message.

---

### 17.5 Sandbox Purchase Succeeds on Device but Server Returns `expired`

**Cause:** Sandbox subscriptions have compressed durations (approximately 5 minutes per
subscription month). If the JWS token arrives at the server after the Sandbox expiry has passed,
`expiresDate <= Date.now()` and the server correctly writes `expired`.

**Resolution:** Call `/verify` immediately after the Sandbox purchase completes. Do not introduce
delays between purchase and server verification when testing in Sandbox.

---

### 17.6 First `/verify` Call Is Slow After Deploy

**Cause:** Apple root CAs are fetched from `apple.com` on the first call after a cold start.
Three HTTPS requests add latency to that single call only. The in-memory cache is populated on
success and used for all subsequent calls for the lifetime of the process.

**Resolution:** Expected behaviour. No action needed.

---

### 17.7 `apple_original_transaction_id` Unique Constraint Violation

**Symptom:** `/restore` returns 500. Render logs show:
```
duplicate key value violates unique constraint "users_apple_original_transaction_id_key"
```

**Cause:** A restore was called with a new device UUID. The `apple_original_transaction_id` from
the JWS is already stored under a different (old device) UUID row.

**Immediate workaround:**
```sql
-- Find the conflicting rows
SELECT id, apple_original_transaction_id, subscription_status, last_verified_at
FROM users
WHERE apple_original_transaction_id = '<value from logs>';

-- Confirm the old UUID is the stale device, then delete it
DELETE FROM users WHERE id = '<old-device-uuid>';
```

Retry the restore after deletion. The new UUID row will be inserted cleanly.

**Long-term fix:** Phase 2 — upsert keyed on `apple_original_transaction_id`, or user accounts.
See [Section 16.3](#163-what-phase-2-will-add).
