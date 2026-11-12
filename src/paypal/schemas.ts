import { z } from "zod";

/** Loose schemas: validate only the fields we rely on; keep the rest untouched. */
const link = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });
const money = z.looseObject({ currency_code: z.string(), value: z.string() });

export const orderSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  links: z.array(link).optional(),
  purchase_units: z
    .array(
      z.looseObject({
        reference_id: z.string().optional(),
        custom_id: z.string().optional(),
        amount: money.optional(),
        payments: z
          .looseObject({
            authorizations: z.array(z.looseObject({ id: z.string(), status: z.string() })).optional(),
            captures: z
              .array(z.looseObject({ id: z.string(), status: z.string(), invoice_id: z.string().optional() }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export const authorizationSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: money.optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  links: z.array(link).optional(),
});

export const captureSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: money.optional(),
  final_capture: z.boolean().optional(),
  invoice_id: z.string().optional(),
  links: z.array(link).optional(),
});

export type Order = z.infer<typeof orderSchema>;
export type Authorization = z.infer<typeof authorizationSchema>;
export type Capture = z.infer<typeof captureSchema>;
