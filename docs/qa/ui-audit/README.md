# UI audit (real Chrome via playwright-core)

* `final/` – the last run: 90 checks passed, 0 failed, 0 findings. Screenshots `desktop-*.png` (1366x900) and `mobile-*.png` (390x844 touch), plus `report.json` (console errors, page errors, failed requests and HTTP errors per viewport).
* `run1` … `run7` – earlier runs kept as history. They contain the defects the audit found and that were then fixed (see `docs/qa/gemini-ui-report.md`); a few zero-byte `ERR-*` files in `run3` are an artifact of a filename with a colon, ignore them.
* Screenshots `13`–`15` are **STUBBED API** states (a Gemini failure, a Gemini success, an incomplete Gemini configuration): there was no live provider to produce them, so the browser was given stubbed API responses to prove how the UI labels those cases. They are not evidence of a real model call.
* Everything else ran against the real app, the real seller simulator process and a throwaway PostgreSQL database (since dropped), with **mock PayPal** and the **rule-based** buyer.
* Reproduce: start the seller (`SELLER_PORT=4010 npm run seller`), start the app in mock mode against a disposable database (see README), then `node scripts/ui-audit.mjs --out docs/qa/ui-audit/<name>`.
