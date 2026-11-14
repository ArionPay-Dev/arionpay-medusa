// Unit tests (no network): signatures, webhook checks and the webhook -> Medusa action mapping.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const lib = require("../dist/arionpay.js")
const { default: Service } = require("../dist/providers/arionpay/service.js")

const WH = "whsec_unit_0001"
const signed = (raw, t = Math.floor(Date.now() / 1000), secret = WH) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`
const logs = []
const logger = { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]), error: (m) => logs.push(["error", m]) }
const options = { apiKey: "pk_unit_000001", apiSecret: "sk_unit", webhookSecret: WH, backendUrl: "https://api.shop.test/", testMode: true }

test("request signatures match the ArionPay backend (reference values from python3 hmac)", () => {
  assert.equal(lib.signRequest("sk_x", 1700000000, "POST", "/api/v1/invoices", '{"a":1}'), "e6855fc36dc68ee45a227f7bfff6965585803c9530238b1b771746c118a91770")
  assert.equal(lib.signRequest("sk_x", 1700000000, "get", "/api/v1/invoices/abc?x=1"), "76c4e503c0883422e6c050aef0becffba060d8814f3a8f95c604dc1914639ef2")
})

test("webhook signature: valid, changed body, wrong secret, stale, malformed, not an event", () => {
  const raw = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { invoice: { id: "a".repeat(24) } } })
  assert.equal(lib.verifyWebhook(Buffer.from(raw), signed(raw), WH).id, "evt_1")
  assert.throws(() => lib.verifyWebhook(raw.replace("paid", "PAID"), signed(raw), WH), /invalid signature/)
  assert.throws(() => lib.verifyWebhook(raw, signed(raw, undefined, "whsec_other"), WH), /invalid signature/)
  assert.throws(() => lib.verifyWebhook(raw, signed(raw, Math.floor(Date.now() / 1000) - 301), WH), /stale/)
  assert.throws(() => lib.verifyWebhook(raw, "t=1", WH), /malformed/)
  assert.throws(() => lib.verifyWebhook(raw, signed(raw), ""), /empty/)
  for (const bad of ["not json", "{}", '{"id":"evt_1","type":"invoice.paid"}', '{"id":"evt_1","type":"invoice.paid","data":{"invoice":null}}']) {
    assert.throws(() => lib.verifyWebhook(bad, signed(bad), WH))
  }
})

test("test events are recognised", () => {
  assert.ok(lib.isTestEvent({ id: "evt_test_1", type: "invoice.paid", data: { invoice: {} } }))
  assert.ok(lib.isTestEvent({ id: "evt_1", type: "invoice.paid", test: true, data: { invoice: {} } }))
  assert.ok(lib.isTestEvent({ id: "evt_1", type: "invoice.paid", data: { invoice: { id: "inv_test_x" } } }))
  assert.ok(!lib.isTestEvent({ id: "evt_1", type: "invoice.paid", data: { invoice: { id: "a".repeat(24) } } }))
})

test("client refuses bad keys and addresses", () => {
  assert.throws(() => new lib.ArionPayClient("nope", "sk"), /pk_/)
  assert.throws(() => new lib.ArionPayClient("pk_abcdefgh", ""), /apiSecret/)
  assert.throws(() => new lib.ArionPayClient("pk_abcdefgh", "sk", "ftp://x"), /http/)
})

test("provider options are checked", () => {
  assert.throws(() => Service.validateOptions({ ...options, apiKey: "x" }), /apiKey/)
  assert.throws(() => Service.validateOptions({ ...options, webhookSecret: "x" }), /webhookSecret/)
  assert.throws(() => Service.validateOptions({ ...options, backendUrl: undefined }), /backendUrl/)
  assert.doesNotThrow(() => Service.validateOptions(options))
})

test("webhook -> Medusa action", async () => {
  const svc = new Service({ logger }, options)
  const site = svc.siteId()
  const invoice = (over = {}) => ({ id: "b".repeat(24), status: "paid", amountFiat: 20, currency: "EUR", test: true, metadata: { medusa_session_id: "payses_1", medusa_amount: "20.00", medusa_currency: "EUR", medusa_site: site }, ...over })
  const hook = async (event, secret = WH) => {
    const raw = JSON.stringify(event)
    return svc.getWebhookActionAndData({ data: {}, rawData: Buffer.from(raw), headers: { "arionpay-signature": signed(raw, undefined, secret) } })
  }
  let r = await hook({ id: "evt_1", type: "invoice.paid", data: { invoice: invoice() } })
  assert.equal(r.action, "captured")
  assert.equal(r.data.session_id, "payses_1")
  assert.equal(Number(r.data.amount.numeric ?? r.data.amount), 20)
  assert.equal((await hook({ id: "evt_2", type: "invoice.pending", data: { invoice: invoice({ status: "pending" }) } })).action, "pending")
  assert.equal((await hook({ id: "evt_3", type: "invoice.paid", data: { invoice: invoice() } }, "whsec_wrong")).action, "not_supported")
  assert.equal((await hook({ id: "evt_4", type: "invoice.paid", data: { invoice: invoice({ test: false }) } })).action, "not_supported")
  assert.equal((await hook({ id: "evt_5", type: "invoice.paid", data: { invoice: invoice({ amountFiat: 19 }) } })).action, "not_supported")
  assert.equal((await hook({ id: "evt_6", type: "invoice.paid", data: { invoice: invoice({ metadata: { ...invoice().metadata, medusa_site: "000000000000" } }) } })).action, "not_supported")
  assert.equal((await hook({ id: "evt_test_7", type: "invoice.paid", data: { invoice: invoice() } })).action, "not_supported")
  assert.equal((await hook({ id: "evt_8", type: "invoice.expired", data: { invoice: invoice({ status: "expired" }) } })).action, "not_supported")
  assert.ok(logs.some(([l, m]) => l === "warn" && /refused: invalid signature/.test(m)))
})

test("authorizePayment trusts only the signed read", async () => {
  const svc = new Service({ logger }, options)
  const site = svc.siteId()
  const data = { session_id: "payses_1", invoice_id: "c".repeat(24), amount: "20.00", currency: "EUR", test: true }
  const read = (over) => async () => ({ id: "c".repeat(24), status: "paid", amountFiat: 20, currency: "EUR", asset: "USDT_TRC20", network: "TRON", paidCrypto: "21.5", test: true, late: false, overpaid: false, underpaidWithinTolerance: false, manual: false, metadata: { medusa_session_id: "payses_1", medusa_site: site }, expiresAt: "", orderId: "", ...over })
  svc.client_.getInvoice = read({})
  assert.equal((await svc.authorizePayment({ data })).status, "captured")
  svc.client_.getInvoice = read({ status: "pending" })
  assert.equal((await svc.authorizePayment({ data })).status, "pending")
  svc.client_.getInvoice = read({ amountFiat: 19.99 })
  assert.equal((await svc.authorizePayment({ data })).status, "error")
  svc.client_.getInvoice = read({ test: false })
  assert.equal((await svc.authorizePayment({ data })).status, "error")
  svc.client_.getInvoice = read({ metadata: { medusa_session_id: "payses_other", medusa_site: site } })
  assert.equal((await svc.authorizePayment({ data })).status, "error")
  assert.equal((await svc.authorizePayment({ data: {} })).status, "error")
})
