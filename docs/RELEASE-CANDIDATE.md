# MANDATE release candidate: verification record

Written for: a reviewer or reproducer who wants to know exactly what this tree is, what was checked on it, what failed along the way, and what was not checked. Date of verification: 2026-11-12 (IST).

**PayPal Sandbox only: no real money. Production is a documented NO-GO and the V2 contract format is disabled.** Nothing in this record is a production-readiness claim.

## 1. What this tree is

The publication source for the PayPal AI Hackathon 2026 submission. It is the earlier audited tree plus a **display-only dashboard update made on 2026-11-11**: a purpose panel, a five-stage workflow derived only from recorded state, a plain-language activity history (the original event names stay available behind "Show technical details"), a challenge-window panel, a per-deal "Why this deal is protected" box, and accessibility fixes. No settlement, authorization, negotiation or verification logic was changed. Two read-only API fields were added (`serverTime`, and the challenge-window and review-deadline timestamps on the deal view).

## 2. Identity

| Item | Value |
|---|---|
| Git history | **None.** This tree was derived from a local working repository whose base commit was `0c65749797f89a28d0c1efc662bd83fb0ba3f44e` (never published), plus uncommitted changes and the 2026-11-11 dashboard update. **No commit contains this exact tree.** |
| Source digest (application source) | `5d4b2dd301a52fedfecfb3558f37c0b71f8d7bdf3b585646209e226b19dac41a` |
| Method | from the repository root: `find src prisma/migrations prisma/schema.prisma package.json package-lock.json -type f \| sort \| xargs sha256sum \| sha256sum` |
| Whole-tree digest | **Not stated here**: a file cannot contain a digest of itself. It is recorded in the owner's release record. Method: from the repository root, `find . -type f \| sort \| xargs sha256sum \| sha256sum`. Expected file count: **1,068**. |
| Predecessor | the improved snapshot before this document, the README edit and the six screenshots below: 1,060 files, digest `49bd71298cee0cc1deebd25c03c33df945f7a8c01a6bcc72b348e9cc0f536768` |

## 3. Verification

Every row was produced by a fresh run on a clean install (`npm ci`) of an isolated copy of this tree (taken before this document, the README correction, the changelog row and the six screenshots were added: the application source, tests and scripts are byte-identical, as checked with a directory comparison), run one stage after another (no concurrent load), against a throwaway database, with **mock PayPal** and the **rule-based buyer**. That environment held no real PayPal or model credential. The toolchain ran with the outbound block (`scripts/lib/block-external-requests.mjs`); the app and seller logs of the README-style launch contained no refused request and no mention of a PayPal or model host.

| Check | Result |
|---|---|
| TypeScript | clean |
| ESLint | clean |
| Production build | success |
| Unit tests | **1,165 passed** (55 files) |
| PostgreSQL integration tests | **658 passed** (29 files, 508 s; clock read before and after) |
| Browser journey (real Chrome, mock PayPal, 25 screenshots) | **81 passed, 0 failed** |
| UI audit (desktop, phone width, stubbed-failure states) | **92 passed, 0 failed, 0 findings** |
| axe-core 4.10.2 on all 25 journey states | **24 of 25 states clean; 1 state reported 1 element** (see "Problems met") |
| Recording-environment smoke test (README-style launch, ports 3200 and 4210) | **25 passed, 0 failed** after correcting the test script (see below) |
| Documentation links | 0 problems |
| Local secret audit | 0 exact secret values (details in section 7) |

The recording-environment smoke test checked, on the README-launched app: the purpose panel on the signed-out screen; the status chips (Rule-based, MOCK, Disabled, local simulator); "No AI model was called" when a deal is opened; the five-stage strip against the recorded state; plain-language history and the technical names behind the toggle; the challenge-window text; the per-deal protection values; keyboard access to the CSV preview and a visible focus outline; zero axe violations on the open-window deal view; **time remaining and time zones**: with the browser clock set 3 hours behind and 3 hours ahead the panel still shows about 9 to 10 minutes left (it follows the server's `serverTime`), and the same instant is shown with the zone name for America/Los_Angeles, Asia/Kolkata and UTC, with the exact UTC instant on hover; and that the browser made no request to any host other than localhost.

### Problems met (not omitted)

* **README defect, fixed here.** The setup step `npx prisma migrate deploy` failed on a fresh checkout with `P1012: Environment variable not found: DATABASE_URL`, because the Prisma CLI reads `.env`, not `.env.local`. The README now says to pass the URL on the command line. With the URL exported the nine migrations applied cleanly.
* **Recording-environment test script, first run:** 3 of its checks failed because the script read the status chips before they had loaded, and one later step timed out, most likely on the app's per-client login rate limit after repeated sign-ins (not separately confirmed). The script was corrected (wait for the chips; reuse one signed-in session). The corrected run passed 25 of 25. No product code changed.
* **axe, 1 element in 1 state.** In this candidate's journey run, axe reported one `color-contrast` node (the amber "Request review" button, `.bg-amber-700`) in the state where the review form had just been filled. The earlier runs on the same source found 0 of 25. The button's steady-state colours are white on `#b45309` (about 5.0:1). The button animates its opacity for 0.15 s when it becomes enabled; in a deliberate reproduction it read opacity 0.96 right after typing and 1.0 after settling, and all nine scans (six immediate, three settled) found 0 violations. **This is consistent with a scan landing in the middle of that transition, but the flagged element was not captured in detail, so that explanation is not proven.** No change was made.
* **Earlier transient failures (during the dashboard update, before this verification).** The first full unit run had 3 failing timing-sensitive tests (two architecture scans and one scan-budget test); they passed alone and on two later full runs. The first full PostgreSQL run had 3 failures in 2 files, one of them reporting an impossible duration of 74,434,736 ms (about 20.7 hours); those files passed alone and the next full run passed 658 of 658. **The cause of that duration anomaly has not been conclusively explained.** The runs on this candidate did not repeat either problem.

### Not tested, and not claimed

* **The real Sandbox deal was not re-tested.** The 14 read-only checks against the completed Sandbox deal were not re-run (they need PayPal requests), and the new dashboard screens have **not** been rendered against that deal. The settlement code is unchanged from what those checks last ran on.
* The attack lab and the mutation checks were not re-run; their recorded results are mock-PayPal and scripted-AI results.
* No screen-reader test, no dark-theme visual test, no test with real users. Passing axe is not the same as being accessible.
* The latest negotiation prompt has not been validated against a live model. No model request was made in this verification.

## 4. Run the demo locally and safely (mock PayPal, rule-based buyer)

Requirements, database and configuration are in the [README](../README.md#setup). For a demo that cannot reach PayPal or a model:

* Leave `PAYPAL_MODE=mock` (the template default). Do **not** set `PAYPAL_MODE=sandbox` or `PAYPAL_SANDBOX_WRITES`.
* Leave the template's model lines as placeholders, or delete them. The dashboard then says **"Rule-based (AI NOT configured)"** and an opened deal says "No AI model was called". Opening a deal is what triggers a negotiation: never open one in a process that has `LLM_PROVIDER=groq` and a key unless you intend a live model call.
* **`APP_URL` must equal the address you type in the browser, character for character.** The login boundary compares the request origin to it: with `APP_URL=http://localhost:3000`, opening `http://127.0.0.1:3000` gets login refused with HTTP 403.
* Use `localhost` consistently, port 3000 for the app and 4010 for the seller, and keep `SELLER_URL` pointing at the seller's actual port.

Launch (bash; in PowerShell set variables with `$env:NAME="value"` before the command):

```bash
# terminal 1: simulated seller (honest; use SELLER_MODE=haggler for the multi-round negotiation)
SELLER_PORT=4010 npm run seller

# terminal 2: build once, then start the app with the outbound block (refuses every non-loopback request and logs it)
npm run build
NODE_OPTIONS="--import ./scripts/lib/block-external-requests.mjs" SELLER_URL=http://127.0.0.1:4010 DEMO_CHALLENGE_WINDOW_SECONDS=600 npx next start -p 3000
```

Do not set the outbound block while running `npm ci` or `npm install`. `DEMO_CHALLENGE_WINDOW_SECONDS` is the length of the buyer's challenge window in seconds (0 to 3600): with the template's 15 the window can end while you are still talking, with 600 the countdown stays visible.

Check: `curl http://127.0.0.1:3000/api/health` answers `{"status":"ok","db":"ok",...}`, and the status chips read Rule-based, MOCK (in memory), Local simulator, Disabled.

Shutdown: press Ctrl+C in each terminal. If a process was left behind: `netstat -ano | findstr LISTENING | findstr :3000`, read the PID in the last column, check it is yours, then `taskkill /PID <pid> /T /F`. Repeat for port 4010.

## 5. Screenshots

* Current dashboard (mock mode, synthetic data): [docs/qa/ui-update-20261111/](qa/ui-update-20261111/README.md), six screens.
* Real Sandbox payment and real Groq negotiation: [docs/submission/screenshots/](submission/screenshots/INDEX.md). **These were captured with the dashboard layout used before 2026-11-11** (same data and decisions, earlier layout).
* Earlier mock journey (25 screens, earlier layout): `docs/qa/final-playwright-e2e/mock/`.

## 6. Known limitations

* The seller is a **local simulator**, not an external merchant and not an OS sandbox. No provider has agreed to anything.
* Delivery verification is **deterministic code**. The engine has 12 validators; the demo screen offers a fixed preset of three (schema, duplicate rows, date format). There is no criteria editor.
* Only the **price negotiation** can use a model. The real Groq negotiation (a recorded 4-round no-deal run, plus an earlier run that closed above its target) and the real PayPal Sandbox payment are **separate runs**; there is no continuous Groq-to-PayPal transaction.
* The captured Sandbox payment was settled under the **expired-window rule**; no explicit buyer acceptance was recorded for it.
* Not exercised against real PayPal: explicit acceptance, partial capture, void, refund, webhooks. Not built: webhooks, hosted deployment, monitoring, distributed rate limits, Payouts, reauthorization after the authorization's honor period.
* The mandate is signed by the **application** after the human confirms its digest, not by a key the buyer holds.
* One buyer account (single principal); no multi-user accounts.
* The dashboard is a dense single-page operator console tied to one fixed demo task; nobody outside the project team has used it.
* No claim is made about users, savings, adoption or competitors' capabilities. MANDATE does not implement or claim compatibility with AP2, and it is not a regulated escrow service.

## 7. Security findings (local audit of this exact tree)

* **No** `.git`, `.env*` file other than `.env.example`, log file, key file, private state (`.spike`), `node_modules` or build output in the tree.
* The local secret audit checked the exact values of ten secrets from the maintainer's environment (database credentials, session and login secrets, signing keys, the PayPal client secret and a model API key) and **found 0 in this tree**. The PayPal Sandbox client id and the maintainer's e-mail address were also absent. No `gsk_`-shaped model key appears anywhere.
* The pattern scan reports **8 credential-shaped strings, none real**: one integrity hash in `package-lock.json`, the placeholder database URL in the README, and test fixtures (`tests/unit/agents-contracts.test.ts`, `tests/db/negotiation.db.test.ts`, `tests/unit/env.test.ts`, `tests/unit/paypal-oauth-check.test.ts`, `tests/unit/sdk-gateway.test.ts`). This is the same set the earlier audit classified.
* Informational: local file-system paths appear in historical build records and in a few scripts (7 files). They contain no credential.
* PayPal identifiers in `docs/` are Sandbox evidence (order, authorization and capture ids of the one completed Sandbox transaction); they are not secrets and no Sandbox account credential is in the tree.
* **Open items for the owner, outside this tree:** the model API key that was used for the recorded Groq runs should be rotated; the licence holder in `LICENSE` ("Prajwal") must be confirmed; a commit identity must be chosen before publication.

## 8. Demo video

**[PENDING: not yet recorded, uploaded or verified.]** The README carries the placeholder "Demo video: *(link to be added after upload)*". When the public URL exists and has been checked signed out, add it to the README, then re-run the link check, the secret audit and both digests.
