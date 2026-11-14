# ArionPay for Medusa

Crypto payments (Bitcoin, USDT, Litecoin, Ethereum, TRON and more) for [Medusa 2](https://medusajs.com) through [ArionPay](https://arionpay.com). The customer pays on the ArionPay payment page and the money goes straight to your own wallet: ArionPay never holds it.

Tested on Medusa 2.22.7 (Node 22, PostgreSQL 16) against a real ArionPay server: 21 checks through the Store API, the same calls a storefront makes. They cover checkout, completing the cart before and after paying, a lost webhook, a cart that changes after the invoice was made, payment tolerance, late payments and webhook security. The package also has 7 unit tests. No dependencies besides Medusa itself.

## Install

```bash
npm install medusa-payment-arionpay
```

In `medusa-config.ts`:

```ts
module.exports = defineConfig({
  // ...
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-arionpay/providers/arionpay",
            id: "arionpay",
            options: {
              apiKey: process.env.ARIONPAY_API_KEY,
              apiSecret: process.env.ARIONPAY_API_SECRET,
              webhookSecret: process.env.ARIONPAY_WEBHOOK_SECRET,
              backendUrl: process.env.MEDUSA_BACKEND_URL,     // public address of this Medusa server
              storefrontUrl: process.env.STOREFRONT_URL,      // optional: where customers come back to
              testMode: process.env.ARIONPAY_TEST_MODE !== "false",
            },
          },
        ],
      },
    },
  ],
})
```

In `.env`:

| Variable | Where in the ArionPay dashboard | Starts with |
| --- | --- | --- |
| `ARIONPAY_API_KEY` | Open your store, **API key** | `pk_` |
| `ARIONPAY_API_SECRET` | Open your store, **API secret** (asks for your authenticator code) | `sk_` |
| `ARIONPAY_WEBHOOK_SECRET` | **Webhooks** page, **signing secret** | `whsec_` |
| `MEDUSA_BACKEND_URL` | your server, e.g. `https://api.shop.example.com` | |
| `ARIONPAY_TEST_MODE` | `false` for real payments (test invoices otherwise) | |

Restart Medusa, then in the Medusa admin open **Settings > Regions**, edit each region that should offer crypto, and add **ArionPay** (`pp_arionpay_arionpay`) to its payment providers.

Nothing to paste into ArionPay: every invoice tells ArionPay to send its payment updates to `<MEDUSA_BACKEND_URL>/hooks/payment/arionpay_arionpay`. (If you register the provider with another `id`, set the `webhookUrl` option to `/hooks/payment/arionpay_<id>`.) In your ArionPay store settings, check that **Old ArionPay (v1) integration compatibility** is off.

ArionPay prices invoices in USD, EUR, GBP, CAD, AUD, CHF, JPY, TRY, AED, INR, BRL, RUB, CNY, SGD, HKD, KRW, MXN, PLN, SEK, NOK and ZAR.

## Storefront

ArionPay is a redirect payment: send the customer to the ArionPay page, and complete the cart when they come back. With the [JS SDK](https://docs.medusajs.com/resources/js-sdk) (for example in the Next.js starter's payment step):

```ts
// 1. The customer chose "Pay with crypto": create the session with a return address.
const { payment_collection } = await sdk.store.payment.initiatePaymentSession(cart, {
  provider_id: "pp_arionpay_arionpay",
  data: { return_url: `${window.location.origin}/checkout/arionpay-return?cart_id=${cart.id}` },
})
const session = payment_collection.payment_sessions.find((s) => s.provider_id === "pp_arionpay_arionpay")

// 2. "Place order": go to the ArionPay payment page.
window.location.href = session.data.invoice_url

// 3. On /checkout/arionpay-return: complete the cart (the provider asks ArionPay whether it is paid).
const result = await sdk.store.cart.complete(cartId)
if (result.type === "order") showConfirmation(result.order)
else showMessage("Your payment is on its way. We will email you as soon as it is confirmed.")
```

These storefront lines follow the Store API calls the tests made; they were not run inside a Next.js storefront.

## How orders are created

- When ArionPay confirms the full payment, its signed `invoice.paid` webhook makes Medusa authorize the payment session and turn the cart into an order, even if the customer never comes back. Crypto payments are final, so the payment is captured at once.
- When the customer comes back and the storefront completes the cart, the provider asks ArionPay directly. A lost webhook is caught there too, and a cart that is already an order returns that order.
- A session counts as paid only when ArionPay itself says the invoice is paid, for the session's amount and currency, test or live like the provider. A webhook alone is never enough: a signed "paid" update for an invoice that ArionPay does not confirm is refused. Medusa then logs "Session ... was not authorized with the provider".
- If the cart changes after the session was made, the next session gets a new invoice for the new total.
- A payment that is not exact goes to **Payment Radar** in your ArionPay dashboard. A small difference inside your store's payment tolerance (default 1%) is accepted automatically; anything else you decide. Late payments still complete the order. The session data records the paid invoice, the coin and notes such as `paid_late` or `underpaid_within_tolerance`.
- Medusa answers every webhook with 200 straight away and checks it afterwards. Refused updates (bad or old signature, test/live mismatch, wrong amount, another shop's invoice, "Send test webhook" samples) are written to the Medusa log and change nothing.

## Good to know

- Refunds: Medusa's refund button records the refund; send the crypto back from your own wallet.
- The provider sends ArionPay the payment session id, amount and currency. It does not send the customer's name, email or address.
- `testMode` is on unless you set it to `false`, so a missing setting never takes real money. Medusa logs a reminder at startup while it is on.

## License

MIT
