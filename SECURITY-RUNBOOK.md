# SWFT CRM — Security Runbook

This file lists every action that must be taken **outside the codebase**
to keep SWFT secure. Anything in here cannot be done by Claude or by
deploying code — it requires the human operator to log into a console.

Treat it as a living checklist. When you set up a new environment, work
through every section. When something here is already done, leave a date
next to it so the next person knows.

---

## 1. Deploy Firestore + Storage rules

Render only redeploys the web server. The rules in `firestore.rules` and
`storage.rules` need to be deployed to Firebase separately — and they
**must** be deployed, because the existing test-mode rules expired on
2026-04-29 and Firestore is currently denying every direct client read
or write.

**Option A — Firebase CLI (preferred, auditable):**
```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,storage:rules --project swft-ai26
```

**Option B — Firebase Console (no CLI install):**
1. Console → Firestore Database → Rules → paste `firestore.rules` → Publish.
2. Console → Storage → Rules → paste `storage.rules` → Publish.

Verification:
- Try opening DevTools on a logged-out browser, run
  `firebase.firestore().collection("customers").get()` — it should fail
  with `permission-denied`.
- Try the same with `firebase.storage().ref("jobs/x").getDownloadURL()`
  — should fail.

---

## 2. Configure Render environment variables

Add these in **Render dashboard → Environment** for the SWFT service:

| Variable | Required? | What it does | How to get it |
|---|---|---|---|
| `ENCRYPT_KEY` | **Yes for prod** | Master key for AES-256-GCM field encryption (currently customer notes; will expand to email/phone after migration). Without it, encryption is a no-op and customer notes go to Firestore in plaintext. | Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — store in 1Password. **Never rotate without a migration script** — old ciphertexts can't be read with a new key. |
| `TURNSTILE_SITE_KEY` | Recommended | Public widget key for the login/signup CAPTCHA. | [Cloudflare Dashboard → Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) → Add Site → choose "Managed" → copy the Site Key. |
| `TURNSTILE_SECRET_KEY` | Recommended | Server-side Turnstile verification key (the secret that pairs with the site key above). | Same Cloudflare page — copy the Secret Key. |

Without `ENCRYPT_KEY`, the field-encryption helper logs nothing and
silently no-ops (so the app keeps working) — but customer notes go to
Firestore in plaintext. Without the Turnstile keys, the CAPTCHA widget
just isn't shown.

---

## 3. Enable Firestore Point-in-Time Recovery (PITR)

PITR keeps a 7-day rolling history of Firestore — so a buggy migration,
a deleted document, or a malicious bulk-delete can be rolled back to
any second within the last week.

**One-time setup:**
1. [GCP Console → Firestore](https://console.cloud.google.com/firestore) → select project `swft-ai26`.
2. Database → choose your database → **Edit** → toggle **Point-in-time recovery** to ON.
3. Note: PITR adds ~$0.10/GB/month of storage cost. Worth it.

**To roll back:**
```bash
gcloud firestore databases restore \
  --source-backup=projects/swft-ai26/locations/<region>/backups/<id> \
  --destination-database=swft-ai26-restored \
  --project=swft-ai26
```
You restore into a *new* database, then verify, then point the app at
it. Never restore in place.

---

## 4. Schedule daily Firestore exports to GCS

PITR covers 7 days. Scheduled exports cover months/years.

1. [Create a GCS bucket](https://console.cloud.google.com/storage) named `swft-firestore-backups`.
   - **Storage class:** Coldline (cheapest for write-once-read-rarely).
   - **Lifecycle rule:** delete objects older than 90 days.
   - **IAM:** restrict to `roles/storage.objectViewer` for everyone except the service account.
2. [GCP Console → Firestore → Backups → Schedules](https://console.cloud.google.com/firestore/databases/-default-/backups).
3. Create schedule: every 24 hours, retention 30 days, target the bucket above.

That's it — Firestore handles the rest.

---

## 5. Enable Identity Platform + TOTP MFA

The 2FA enrollment UI in `swft-settings.html` uses Firebase's built-in
`TotpMultiFactorGenerator`. It requires the project to be on **Firebase
Identity Platform** (paid tier — free quota: 50K MAU). Without it,
clicking "Set up 2FA" shows a graceful "needs Identity Platform" message.

1. [GCP Console → Identity Platform](https://console.cloud.google.com/customer-identity) → Enable.
2. Authentication → Settings → Multi-factor → **Add factor → TOTP**.
3. (Optional) require MFA for specific user roles via custom claims.

After enabling, refresh the SWFT settings page → Account Security →
"Set up 2FA" should now show the QR code instead of the placeholder
message.

---

## 6. Rotate Firebase Admin SDK service account quarterly

The Admin SDK service account JSON in `FIREBASE_SERVICE_ACCOUNT_JSON`
on Render has full read/write to every collection. If it leaks, you've
lost everything. Rotate it every 90 days.

1. [GCP IAM → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) → find the firebase-adminsdk one.
2. Keys tab → **Add Key → Create new key (JSON)**.
3. Update Render → Environment → `FIREBASE_SERVICE_ACCOUNT_JSON` with the new key.
4. Redeploy.
5. Once you've confirmed the new key works (try `/health`), go back to GCP
   IAM and **delete the old key**. Don't leave both active.

---

## 7. Review the security audit log monthly

Settings → Account Security → Recent security activity shows recent events
for *your* account. For an org-wide view, query Firestore directly:

```js
// In Firestore Console, Filter on collection: securityAudit
// Sort: ts desc, Limit: 100
```

Things to look for:
- `lockout_triggered` events from unfamiliar IPs → someone is brute-
  forcing an account. Consider notifying the affected user.
- `reauth_challenged` from one user but many different IPs → token theft.
  Ask them to change their password and click "Sign out everywhere."
- Any `sessions_revoked` events you didn't trigger yourself.

---

## 8. Pen test before significant launches

Code review (incl. /ultrareview) catches bugs. It does not catch
business-logic flaws, race conditions, or chained vulns. Before any
major launch — first paying customer, public marketing push,
B2B sale — pay a pen-tester (HackerOne triage / a freelancer on
Cobalt) for a 1–2 week engagement against the staging environment.

Budget $5–15K. Worth it.

---

## 9. Incident response

If you suspect a breach:

1. **Immediately**: rotate the Firebase Admin service account (section 6).
2. Run the Render redeploy hook to invalidate any in-flight requests.
3. Force-revoke every user session: in Firestore, set
   `tokensValidAfterTime` to *now* on every user doc — easiest via a
   one-off script using `authAdmin.revokeRefreshTokens(uid)` for each.
4. Pull the last 7 days of Cloud Run / Render logs and grep for the
   compromised IP / user.
5. Notify affected customers within 72 hours (GDPR requirement).

Keep this runbook printed somewhere offline — if your laptop is
compromised, you don't want the response plan to be in the same
1Password vault as the credentials you're rotating.
