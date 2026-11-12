import { createServer, type Server } from "node:http";
import Decimal from "decimal.js";
import { deliverRequestSchema, deliverResponseSchema, negotiateRequestSchema, sellerResponseSchema } from "../src/agents/contracts";
import { buildDelivery } from "./delivery";
import { decide, type SellerMode } from "./brain";

const MAX_BODY = 64 * 1024;
const SENSITIVE_ENV = /SECRET|TOKEN|PASSWORD|KEY|DATABASE|PAYPAL|MANDATE|SESSION|ANTHROPIC|GEMINI|GOOGLE|GROQ/i;

/**
 * The Seller Agent's HTTP face. It validates the request with the shared strict contract, decides with its own private
 * floor price, and validates its OWN response before sending. It has no database, no PayPal, no mandate and no access
 * to the buyer's prompts. GET /whoami reports which sensitive environment variable NAMES it can see (expected: none).
 */
export function createSellerServer(cfg: { mode: SellerMode; floor?: string }): Server {
  // the haggler demo scenario defaults to a private floor above the demo buyer's target (20.00) so it must counteroffer; SELLER_FLOOR overrides
  const floor = new Decimal(cfg.floor ?? (cfg.mode === "haggler" ? "22.00" : "18.00"));
  const sendJson = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { status: "ok", agent: "simulated-seller", mode: cfg.mode });
    if (req.method === "GET" && req.url === "/whoami") {
      return sendJson(res, 200, {
        agent: "simulated-seller",
        mode: cfg.mode,
        pid: process.pid,
        sensitiveEnvNames: Object.keys(process.env).filter((k) => SENSITIVE_ENV.test(k)),
        envNameCount: Object.keys(process.env).length,
      });
    }
    if (req.method === "POST" && (req.url === "/negotiate" || req.url === "/deliver")) {
      const isDeliver = req.url === "/deliver";
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          sendJson(res, 413, { error: "TOO_LARGE" });
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", async () => {
        if (res.writableEnded) return;
        let json: unknown;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return sendJson(res, 400, { error: "BAD_JSON" });
        }
        if (isDeliver) {
          const d = deliverRequestSchema.safeParse(json);
          if (!d.success) return sendJson(res, 400, { error: "BAD_REQUEST" });
          const out = await buildDelivery(d.data);
          if (!deliverResponseSchema.safeParse(out).success) return sendJson(res, 500, { error: "SELLER_BUG" });
          return sendJson(res, 200, out);
        }
        const parsed = negotiateRequestSchema.safeParse(json);
        if (!parsed.success) return sendJson(res, 400, { error: "BAD_REQUEST" });
        const response = decide(cfg.mode, floor, parsed.data);
        // "tamper" mode intentionally emits an out-of-contract body; every other mode must satisfy our own contract.
        if (cfg.mode !== "tamper" && !sellerResponseSchema.safeParse(response).success) return sendJson(res, 500, { error: "SELLER_BUG" });
        return sendJson(res, 200, response);
      });
      return;
    }
    return sendJson(res, 404, { error: "NOT_FOUND" });
  });
}
