/**
 * Step idempotency. A step is identified by (dealId, step, key). Exactly one worker executes it at a time; a COMPLETED step is never
 * executed again (the stored result is replayed); a worker that crashes mid-step leaves a STARTED row whose lease expires, after which
 * ONE other worker takes it over (atomic compare-and-set). Steps whose outcome is "not yet" (waiting, in doubt) are left OPEN so a later
 * call re-runs them. Every layer underneath (delivery, verification, intake, settlement) is itself idempotent, so a re-run after a crash
 * cannot duplicate a logical action; this table makes that explicit and observable and records the ledger entry exactly once.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { appendEvent } from "../domain/ledger";
import { sha256Hex } from "../domain/canonical";

export interface StepRef {
  dealId: string;
  step: string;
  key: string;
}
export interface StepOutcome<T> {
  value: T;
  /** true: the logical step is finished (COMPLETED, replayed forever). false: leave OPEN so a later call can run it again. */
  final: boolean;
}
export type StepRun<T> = { kind: "RAN"; value: T; attempts: number } | { kind: "REPLAYED"; value: T } | { kind: "IN_PROGRESS" };

export async function runStep<T extends Record<string, unknown>>(
  db: PrismaClient,
  ref: StepRef,
  opts: { now: () => Date; leaseMs: number },
  fn: () => Promise<StepOutcome<T>>,
): Promise<StepRun<T>> {
  const now = opts.now();
  const lease = new Date(now.getTime() + opts.leaseMs);
  const where = { dealId_step_idempotencyKey: { dealId: ref.dealId, step: ref.step, idempotencyKey: ref.key } };
  let attempts = 1;
  let claimed = false;
  try {
    await db.orchestrationStep.create({ data: { dealId: ref.dealId, step: ref.step, idempotencyKey: ref.key, status: "STARTED", leaseExpiresAt: lease } });
    claimed = true;
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  if (!claimed) {
    const row = await db.orchestrationStep.findUniqueOrThrow({ where });
    if (row.status === "COMPLETED") return { kind: "REPLAYED", value: row.resultJson as T };
    // OPEN (retry wanted) or STARTED whose lease expired (crashed worker): exactly one caller wins the takeover
    const took = await db.orchestrationStep.updateMany({
      where: { id: row.id, OR: [{ status: "OPEN" }, { status: "STARTED", leaseExpiresAt: { lt: now } }] },
      data: { status: "STARTED", attempts: { increment: 1 }, leaseExpiresAt: lease, error: null },
    });
    if (took.count !== 1) return { kind: "IN_PROGRESS" };
    attempts = row.attempts + 1;
  }
  let out: StepOutcome<T>;
  try {
    out = await fn();
  } catch (e) {
    await db.orchestrationStep.updateMany({ where: { dealId: ref.dealId, step: ref.step, idempotencyKey: ref.key }, data: { status: "OPEN", leaseExpiresAt: null, error: (e as Error).name.slice(0, 60) } });
    throw e;
  }
  await db.$transaction(async (tx) => {
    await tx.orchestrationStep.update({ where, data: { status: out.final ? "COMPLETED" : "OPEN", resultJson: out.value as Prisma.InputJsonValue, leaseExpiresAt: null, error: null } });
    // The ledger records a step's outcome once, when it is finally completed; replays and polling add nothing.
    if (out.final) await appendEvent(tx, ref.dealId, "ORCHESTRATION_STEP", "orchestrator", { step: ref.step, key: sha256Hex(ref.key).slice(0, 16), attempts, outcome: out.value });
  });
  return { kind: "RAN", value: out.value, attempts };
}
