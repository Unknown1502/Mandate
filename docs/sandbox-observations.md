# Sandbox Observations

Facts captured from REAL calls to `https://api-m.sandbox.paypal.com` by the Phase 1 spike harness
(`scripts/spike/run.ts`). Entries below the "Raw call log" heading are appended automatically by code and
sanitized (tokens, client secrets, payer/payee personal data are replaced with `[REDACTED]`).
Interpretation lives in the sections above the log and is written separately; anything not exercised is
marked **UNVERIFIED**. Nothing here is a mock.

## Raw call log

### OBS-001 · S01 · OAuth token acquisition
- Time (UTC): 2026-11-05T17:25:32.595Z
- Endpoint: `POST /v1/oauth2/token`
- Request headers (sanitized): {"Content-Type":"application/x-www-form-urlencoded","Authorization":"Basic [REDACTED]"}
- PayPal-Request-Id: n/a
- Request body (sanitized):
```json
"grant_type=client_credentials"
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f13324781aaf2
- Duration: 2807 ms
- Response body (sanitized):
```json
{
  "scope": "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token https://uri.paypal.com/services/payments/futurepayments https://uri.paypal.com/services/vault/payment-tokens/read https://uri.paypal.com/services/disputes/read-buyer https://uri.paypal.com/services/payments/realtimepayment https://uri.paypal.com/services/subscriptions/confirm-payment https://uri.paypal.com/services/payments/client-payments-eligibility https://api.paypal.com/v1/vault/credit-card https://api.paypal.com/v1/payments/.* https://uri.paypal.com/services/vault/payment-tokens/readwrite https://uri.paypal.com/services/applications/webhooks https://uri.paypal.com/services/pricing/exchange-currency/read https://uri.paypal.com/services/credit/client-offer-presentment/read https://uri.paypal.com/services/disputes/update-seller https://uri.paypal.com/services/payments/payment/authcapture openid Braintree:Vault https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/payments/orders/client_sdk_orders_api https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/disputes/create https://uri.paypal.com/services/pricing/quote-exchange-rates/read https://uri.paypal.com/services/documents/disputes/download https://uri.paypal.com/services/billing-agreements https://uri.paypal.com/services/checkout/payment-resources https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.* https://uri.paypal.com/services/subscriptions",
  "access_token": "[REDACTED]",
  "token_type": "Bearer",
  "app_id": "APP-9DW53688RP347725R",
  "expires_in": 32400,
  "nonce": "[REDACTED]"
}
```

### OBS-002 · S02 · Create AUTHORIZE order (scenario: partial_open)
- Time (UTC): 2026-11-05T17:25:42.223Z
- Endpoint: `POST /v1/oauth2/token`
- Request headers (sanitized): {"Content-Type":"application/x-www-form-urlencoded","Authorization":"Basic [REDACTED]"}
- PayPal-Request-Id: n/a
- Request body (sanitized):
```json
"grant_type=client_credentials"
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f6966379f451f
- Duration: 617 ms
- Response body (sanitized):
```json
{
  "scope": "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token https://uri.paypal.com/services/payments/futurepayments https://uri.paypal.com/services/vault/payment-tokens/read https://uri.paypal.com/services/disputes/read-buyer https://uri.paypal.com/services/payments/realtimepayment https://uri.paypal.com/services/subscriptions/confirm-payment https://uri.paypal.com/services/payments/client-payments-eligibility https://api.paypal.com/v1/vault/credit-card https://api.paypal.com/v1/payments/.* https://uri.paypal.com/services/vault/payment-tokens/readwrite https://uri.paypal.com/services/applications/webhooks https://uri.paypal.com/services/pricing/exchange-currency/read https://uri.paypal.com/services/credit/client-offer-presentment/read https://uri.paypal.com/services/disputes/update-seller https://uri.paypal.com/services/payments/payment/authcapture openid Braintree:Vault https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/payments/orders/client_sdk_orders_api https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/disputes/create https://uri.paypal.com/services/pricing/quote-exchange-rates/read https://uri.paypal.com/services/documents/disputes/download https://uri.paypal.com/services/billing-agreements https://uri.paypal.com/services/checkout/payment-resources https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.* https://uri.paypal.com/services/subscriptions",
  "access_token": "[REDACTED]",
  "token_type": "Bearer",
  "app_id": "APP-9DW53688RP347725R",
  "expires_in": 32393,
  "nonce": "[REDACTED]"
}
```

### OBS-003 · S02 · Create AUTHORIZE order (scenario: partial_open)
- Time (UTC): 2026-11-05T17:25:42.846Z
- Endpoint: `POST /v2/checkout/orders`
- Request headers (sanitized): {"Accept":"application/json","Authorization":"Bearer [REDACTED]","Content-Type":"application/json","PayPal-Request-Id":"mandate-spike-202611051725-partial_open-create-1","Prefer":"return=representation"}
- PayPal-Request-Id: mandate-spike-202611051725-partial_open-create-1
- Request body (sanitized):
```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [
    {
      "reference_id": "202611051725-partial_open",
      "custom_id": "202611051725-partial_open",
      "description": "MANDATE spike partial_open",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "http://localhost:3000/paypal/return",
        "cancel_url": "http://localhost:3000/paypal/cancel",
        "user_action": "PAY_NOW",
        "shipping_preference": "NO_SHIPPING"
      }
    }
  }
}
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f696637c3d1c8
- Duration: 1652 ms
- Response body (sanitized):
```json
{
  "id": "6J938166EX451764G",
  "intent": "AUTHORIZE",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": {
    "paypal": {}
  },
  "purchase_units": [
    {
      "reference_id": "202611051725-partial_open",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      },
      "payee": {
        "email_address": "[REDACTED]",
        "merchant_id": "[REDACTED]"
      },
      "description": "MANDATE spike partial_open",
      "custom_id": "202611051725-partial_open"
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/6J938166EX451764G",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=6J938166EX451764G",
      "rel": "payer-action",
      "method": "GET"
    }
  ]
}
```

### OBS-004 · S02 · Create AUTHORIZE order (scenario: full)
- Time (UTC): 2026-11-05T17:25:44.504Z
- Endpoint: `POST /v2/checkout/orders`
- Request headers (sanitized): {"Accept":"application/json","Authorization":"Bearer [REDACTED]","Content-Type":"application/json","PayPal-Request-Id":"mandate-spike-202611051725-full-create-1","Prefer":"return=representation"}
- PayPal-Request-Id: mandate-spike-202611051725-full-create-1
- Request body (sanitized):
```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [
    {
      "reference_id": "202611051725-full",
      "custom_id": "202611051725-full",
      "description": "MANDATE spike full",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "http://localhost:3000/paypal/return",
        "cancel_url": "http://localhost:3000/paypal/cancel",
        "user_action": "PAY_NOW",
        "shipping_preference": "NO_SHIPPING"
      }
    }
  }
}
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f588886ce245b
- Duration: 1435 ms
- Response body (sanitized):
```json
{
  "id": "68C462760E533140P",
  "intent": "AUTHORIZE",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": {
    "paypal": {}
  },
  "purchase_units": [
    {
      "reference_id": "202611051725-full",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      },
      "payee": {
        "email_address": "[REDACTED]",
        "merchant_id": "[REDACTED]"
      },
      "description": "MANDATE spike full",
      "custom_id": "202611051725-full"
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/68C462760E533140P",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=68C462760E533140P",
      "rel": "payer-action",
      "method": "GET"
    }
  ]
}
```

### OBS-005 · S02 · Create AUTHORIZE order (scenario: partial_final)
- Time (UTC): 2026-11-05T17:25:45.948Z
- Endpoint: `POST /v2/checkout/orders`
- Request headers (sanitized): {"Accept":"application/json","Authorization":"Bearer [REDACTED]","Content-Type":"application/json","PayPal-Request-Id":"mandate-spike-202611051725-partial_final-create-1","Prefer":"return=representation"}
- PayPal-Request-Id: mandate-spike-202611051725-partial_final-create-1
- Request body (sanitized):
```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [
    {
      "reference_id": "202611051725-partial_final",
      "custom_id": "202611051725-partial_final",
      "description": "MANDATE spike partial_final",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "http://localhost:3000/paypal/return",
        "cancel_url": "http://localhost:3000/paypal/cancel",
        "user_action": "PAY_NOW",
        "shipping_preference": "NO_SHIPPING"
      }
    }
  }
}
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f367587ebdcc8
- Duration: 1547 ms
- Response body (sanitized):
```json
{
  "id": "5GR606463M4213332",
  "intent": "AUTHORIZE",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": {
    "paypal": {}
  },
  "purchase_units": [
    {
      "reference_id": "202611051725-partial_final",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      },
      "payee": {
        "email_address": "[REDACTED]",
        "merchant_id": "[REDACTED]"
      },
      "description": "MANDATE spike partial_final",
      "custom_id": "202611051725-partial_final"
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/5GR606463M4213332",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=5GR606463M4213332",
      "rel": "payer-action",
      "method": "GET"
    }
  ]
}
```

### OBS-006 · S02 · Create AUTHORIZE order (scenario: void)
- Time (UTC): 2026-11-05T17:25:47.500Z
- Endpoint: `POST /v2/checkout/orders`
- Request headers (sanitized): {"Accept":"application/json","Authorization":"Bearer [REDACTED]","Content-Type":"application/json","PayPal-Request-Id":"mandate-spike-202611051725-void-create-1","Prefer":"return=representation"}
- PayPal-Request-Id: mandate-spike-202611051725-void-create-1
- Request body (sanitized):
```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [
    {
      "reference_id": "202611051725-void",
      "custom_id": "202611051725-void",
      "description": "MANDATE spike void",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      }
    }
  ],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "return_url": "http://localhost:3000/paypal/return",
        "cancel_url": "http://localhost:3000/paypal/cancel",
        "user_action": "PAY_NOW",
        "shipping_preference": "NO_SHIPPING"
      }
    }
  }
}
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: f1119275666c6
- Duration: 997 ms
- Response body (sanitized):
```json
{
  "id": "81494218YG431211M",
  "intent": "AUTHORIZE",
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": {
    "paypal": {}
  },
  "purchase_units": [
    {
      "reference_id": "202611051725-void",
      "amount": {
        "currency_code": "USD",
        "value": "10.00"
      },
      "payee": {
        "email_address": "[REDACTED]",
        "merchant_id": "[REDACTED]"
      },
      "description": "MANDATE spike void",
      "custom_id": "202611051725-void"
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/81494218YG431211M",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.sandbox.paypal.com/checkoutnow?token=81494218YG431211M",
      "rel": "payer-action",
      "method": "GET"
    }
  ]
}
```

### OBS-007 · S00 · unlabelled
- Time (UTC): 2026-11-05T17:30:19.701Z
- Endpoint: `POST /v1/oauth2/token`
- Request headers (sanitized): {"Content-Type":"application/x-www-form-urlencoded","Authorization":"Basic [REDACTED]"}
- PayPal-Request-Id: n/a
- Request body (sanitized):
```json
"grant_type=client_credentials"
```
- Outcome: RESPONSE
- HTTP status: 200
- PayPal debug id: ca55d9606dde0
- Duration: 1571 ms
- Response body (sanitized):
```json
{
  "scope": "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token https://uri.paypal.com/services/payments/futurepayments https://uri.paypal.com/services/vault/payment-tokens/read https://uri.paypal.com/services/disputes/read-buyer https://uri.paypal.com/services/payments/realtimepayment https://uri.paypal.com/services/subscriptions/confirm-payment https://uri.paypal.com/services/payments/client-payments-eligibility https://api.paypal.com/v1/vault/credit-card https://api.paypal.com/v1/payments/.* https://uri.paypal.com/services/vault/payment-tokens/readwrite https://uri.paypal.com/services/applications/webhooks https://uri.paypal.com/services/pricing/exchange-currency/read https://uri.paypal.com/services/credit/client-offer-presentment/read https://uri.paypal.com/services/disputes/update-seller https://uri.paypal.com/services/payments/payment/authcapture openid Braintree:Vault https://uri.paypal.com/services/disputes/read-seller https://uri.paypal.com/services/payments/orders/client_sdk_orders_api https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/disputes/create https://uri.paypal.com/services/pricing/quote-exchange-rates/read https://uri.paypal.com/services/documents/disputes/download https://uri.paypal.com/services/billing-agreements https://uri.paypal.com/services/checkout/payment-resources https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.* https://uri.paypal.com/services/subscriptions",
  "access_token": "[REDACTED]",
  "token_type": "Bearer",
  "app_id": "APP-9DW53688RP347725R",
  "expires_in": 32114,
  "nonce": "[REDACTED]"
}
```

