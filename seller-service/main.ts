/** Entry point for the Seller Agent process:  tsx seller-service/main.ts   (env: SELLER_PORT, SELLER_MODE, SELLER_FLOOR) */
import type { AddressInfo } from "node:net";
import { createSellerServer } from "./server";
import type { SellerMode } from "./brain";

const MODES: SellerMode[] = ["honest", "haggler", "greedy", "adversarial", "tamper"];
const mode = (process.env.SELLER_MODE ?? "honest") as SellerMode;
if (!MODES.includes(mode)) throw new Error(`SELLER_MODE must be one of ${MODES.join(", ")}`);

const server = createSellerServer({ mode, floor: process.env.SELLER_FLOOR });
// Loopback only: this process is a local simulation and must not be reachable from other machines.
server.listen(Number(process.env.SELLER_PORT ?? 0), "127.0.0.1", () => {
  console.log(`SELLER_LISTENING ${(server.address() as AddressInfo).port} mode=${mode}`);
});
