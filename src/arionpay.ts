/**
 * Minimal ArionPay API client (signed requests and webhook checks), so the provider has no runtime dependencies.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

export const DEFAULT_BASE_URL = "https://merchant.arionpay.com"
export const VERSION = "1.0.1"

export class ArionPayApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string = "") {
    super(message)
    this.name = "ArionPayApiError"
  }
}

export type Invoice = {
  id: string
  status: string
  orderId: string
  amountFiat: number | null
  currency: string
  asset: string
  network: string
  paidCrypto: string
  test: boolean
  late: boolean
  overpaid: boolean
  underpaidWithinTolerance: boolean
  manual: boolean
  metadata: Record<string, unknown>
  expiresAt: string
}

export type WebhookEvent = { id: string; type: string; test?: boolean; data: { invoice: Record<string, unknown> } }

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v))
const n = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v))

export function signRequest(secret: string, ts: number, method: string, pathAndQuery: string, body = ""): string {
  const data = method.toUpperCase() === "GET" ? `${ts}.GET ${pathAndQuery}` : `${ts}.${body}`
  return createHmac("sha256", secret).update(data).digest("hex")
}

/** Checks the ArionPay-Signature header ("t=..,v1=..") against the exact raw body. Throws when it must not be trusted. */
export function verifyWebhook(raw: Buffer | string, header: string | undefined, secret: string, toleranceSec = 300): WebhookEvent {
  if (!secret) throw new Error("webhook secret is empty")
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]))
  const t = parts.t ?? ""
  const v1 = (parts.v1 ?? "").toLowerCase()
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) throw new Error("missing or malformed ArionPay-Signature header")
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) throw new Error("stale signature")
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8")
  const expected = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest("hex")
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) throw new Error("invalid signature")
  let event: WebhookEvent
  try {
    event = JSON.parse(body.toString("utf8"))
  } catch {
    throw new Error("body is not JSON")
  }
  if (!event || typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type || typeof event.data?.invoice !== "object" || !event.data.invoice) {
    throw new Error("not an ArionPay event")
  }
  return event
}

export function isTestEvent(event: WebhookEvent): boolean {
  return event.test === true || event.id.startsWith("evt_test_") || s(event.data.invoice.id).startsWith("inv_test_")
}

/** The webhook's data.invoice, typed. */
export function webhookInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: s(r.id), status: s(r.status).toLowerCase(), orderId: s(r.orderId), amountFiat: n(r.amountFiat), currency: s(r.currency),
    asset: s(r.asset), network: s(r.network), paidCrypto: s(r.paidCrypto), test: r.test === true, late: r.late === true,
    overpaid: r.overpaid === true, underpaidWithinTolerance: r.underpaidWithinTolerance === true, manual: r.manual === true,
    metadata: (r.metadata && typeof r.metadata === "object" ? r.metadata : {}) as Record<string, unknown>, expiresAt: s(r.expiresAt),
  }
}

export class ArionPayClient {
  private origin: string
  private basePath: string

  constructor(private apiKey: string, private apiSecret: string, baseUrl = DEFAULT_BASE_URL, private appInfo = "") {
    if (!/^pk_[A-Za-z0-9_-]{8,64}$/.test(apiKey)) throw new Error("ArionPay: apiKey must be your store API key (it starts with pk_)")
    if (!apiSecret) throw new Error("ArionPay: apiSecret is required (it starts with sk_)")
    const u = new URL(baseUrl || DEFAULT_BASE_URL)
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("ArionPay: baseUrl must be an http(s) address")
    this.origin = u.origin
    this.basePath = u.pathname.replace(/\/+$/, "")
  }

  async createInvoice(params: Record<string, unknown>): Promise<{ id: string; invoiceUrl: string; status: string; expiresAt: string }> {
    const body = { ...params, idempotencyKey: params.idempotencyKey ?? `sdk_${randomUUID()}` }
    const r = await this.request("POST", "/api/v1/invoices", body, true)
    const d = (r.data && typeof r.data === "object" ? r.data : r) as Record<string, unknown>
    return { id: s(d.id ?? r.id), invoiceUrl: s(d.invoice_url ?? r.invoice_url), status: s(d.status) || "new", expiresAt: s(d.expires_at) }
  }

  /** Signed read, in the webhook's field names. */
  async getInvoice(id: string): Promise<Invoice> {
    if (!/^[0-9a-fA-F]{24}$/.test(id)) throw new Error("ArionPay: invalid invoice id")
    const r = await this.request("GET", `/api/v1/invoices/${id}`, undefined, true)
    return webhookInvoice({
      ...r, id: r.invoiceId ?? r.id, asset: r.settledCurrency, amountCrypto: r.amountExpected, paidCrypto: r.amountReceived ?? "0",
    })
  }

  private async request(method: string, path: string, body: unknown, retrySafe: boolean, attempt = 1, replayRetried = false): Promise<Record<string, any>> {
    const full = this.basePath + path
    const raw = body === undefined ? undefined : JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000)
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `arionpay-medusa/${VERSION} node/${process.versions.node}${this.appInfo ? " " + this.appInfo : ""}`,
      "x-api-key": this.apiKey,
      "x-timestamp": String(ts),
      "x-signature": signRequest(this.apiSecret, ts, method, full, raw ?? ""),
    }
    if (raw !== undefined) headers["content-type"] = "application/json"
    let res: Response
    try {
      res = await fetch(this.origin + full, { method, headers, body: raw, redirect: "manual", signal: AbortSignal.timeout(20000) })
    } catch (e) {
      if (retrySafe && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
        return this.request(method, path, body, retrySafe, attempt + 1, replayRetried)
      }
      throw new ArionPayApiError(`Could not reach ArionPay: ${(e as Error).message}`, 0, "network_error")
    }
    const text = await res.text()
    let obj: Record<string, any> = {}
    try {
      const v = text ? JSON.parse(text) : {}
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v
    } catch {
      /* an HTML error page from a proxy: keep the status */
    }
    if (res.status >= 200 && res.status < 300) return obj
    const message = typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : `HTTP ${res.status}`
    // Two identical signed requests in the same second carry the same signature; only the first is accepted.
    if (res.status === 401 && /already used/i.test(message) && !replayRetried) {
      await new Promise((r) => setTimeout(r, 1100))
      return this.request(method, path, body, retrySafe, attempt, true)
    }
    if (retrySafe && attempt < 3 && [502, 503, 504].includes(res.status)) {
      await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
      return this.request(method, path, body, retrySafe, attempt + 1, replayRetried)
    }
    throw new ArionPayApiError(`ArionPay API error (${res.status}): ${message}`, res.status, typeof obj.code === "string" ? obj.code : "")
  }
}
