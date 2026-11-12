/**
 * Generate the Ed25519 mandate-sealing keypair.
 *   npm run gen-keys -- --write-env   appends to .env.local WITHOUT printing the keys (refuses to overwrite)
 *   npm run gen-keys                  prints them (do not paste into chat or commit)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSigningKeys } from "../src/domain/signing";
import { planKeyWrite } from "./lib/env-keys";

const keys = generateSigningKeys("v1");
if (process.argv.includes("--write-env")) {
  const path = ".env.local";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const plan = planKeyWrite(current, keys); // a replace_me placeholder (copied from .env.example) counts as not set; a real key is never overwritten
  if (!plan.ok) {
    console.error("MANDATE_SIGNING_PRIVATE_KEY already set in .env.local; refusing to overwrite (it would invalidate sealed mandates).");
    process.exit(1);
  }
  writeFileSync(path, plan.next);
  console.log("Keys written to .env.local (not printed).");
} else {
  console.log(`MANDATE_SIGNING_PRIVATE_KEY=${keys.privateKeyB64}\nMANDATE_SIGNING_PUBLIC_KEY=${keys.publicKeyB64}`);
}
