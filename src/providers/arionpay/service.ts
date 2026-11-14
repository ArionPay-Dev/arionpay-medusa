/**
 * ArionPay payment provider for Medusa 2: crypto payments on the ArionPay payment page, paid straight to the
 * merchant's own wallet.
 *
 * A payment session counts as paid only when a signed read of its ArionPay invoice says "paid", for the same amount
 * and currency, test or live like the provider. A signed invoice.paid webhook makes Medusa check it at once.
 */
import { createHash } from "node:crypto"
import { AbstractPaymentProvider, BigNumber, MedusaError, PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput, AuthorizePaymentOutput, CancelPaymentInput, CancelPaymentOutput, CapturePaymentInput, CapturePaymentOutput,
  DeletePaymentInput, DeletePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput, InitiatePaymentInput, InitiatePaymentOutput,
  Logger, ProviderWebhookPayload, RefundPaymentInput, RefundPaymentOutput, RetrievePaymentInput, RetrievePaymentOutput,
  UpdatePaymentInput, UpdatePaymentOutput, WebhookActionResult,
} from "@medusajs/framework/types"
import { ArionPayClient, type Invoice, isTestEvent, VERSION, verifyWebhook, webhookInvoice } from "../../arionpay"

export type ArionPayOptions = {
  /** pk_... (ArionPay dashboard > your store) */
  apiKey: string
  /** sk_... */
  apiSecret: string
  /** whsec_... (ArionPay dashboard > Webhooks) */
  webhookSecret: string
  /** Public address of this Medusa server, e.g. https://api.shop.example.com (for the webhook address). */
  backendUrl?: string
  /** The full webhook address, when it is not <backendUrl>/hooks/payment/arionpay_arionpay. */
  webhookUrl?: string
  /** Where customers come back to when the storefront passes no return_url, e.g. https://shop.example.com/checkout */
  storefrontUrl?: string
  /** Test invoices (no real money). Default true: set false for real payments. */
  testMode?: boolean
  /** Leave empty unless ArionPay tells you otherwise. */
  baseUrl?: string
}

type SessionData = {
  session_id?: string
  invoice_id?: string
  invoice_url?: string
  amount?: string
  currency?: string
  test?: boolean
  attempt?: number
  paid_invoice?: string
  return_url?: string
  cancel_url?: string
  [k: string]: unknown
}

const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "TRY", "AED", "INR", "BRL", "RUB", "CNY", "SGD", "HKD", "KRW", "MXN", "PLN", "SEK", "NOK", "ZAR"]
const OPEN = ["pending", "paid_partial", "claim_pending"]
const money = (v: unknown) => (Math.round(Number(new BigNumber(v as any).numeric) * 100) / 100).toFixed(2)

class ArionPayProviderService extends AbstractPaymentProvider<ArionPayOptions> {
  static identifier = "arionpay"

  protected options_: ArionPayOptions
  protected logger_: Logger
  protected client_: ArionPayClient

  static validateOptions(options: Record<string, unknown>): void {
    const need = (k: string, re: RegExp, what: string) => {
      if (typeof options[k] !== "string" || !re.test(options[k] as string)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, `ArionPay: option "${k}" must be your ${what}.`)
      }
    }
    need("apiKey", /^pk_[A-Za-z0-9_-]{8,64}$/, "store API key (starts with pk_)")
    need("apiSecret", /^sk_/, "store API secret (starts with sk_)")
    need("webhookSecret", /^whsec_/, "webhook signing secret (starts with whsec_)")
    if (!options.backendUrl && !options.webhookUrl) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'ArionPay: set option "backendUrl" (the public address of this Medusa server) so ArionPay can send payment updates.')
    }
  }

  constructor(container: { logger: Logger }, options: ArionPayOptions) {
    super(container, options)
    this.options_ = options
    this.logger_ = container.logger
    this.client_ = new ArionPayClient(options.apiKey, options.apiSecret, options.baseUrl, `medusa-payment-arionpay/${VERSION}`)
    if (this.isTest()) this.logger_.info("ArionPay: test mode is on (test invoices, no real money). Set testMode: false for real payments.")
  }

  private isTest(): boolean {
    return this.options_.testMode !== false
  }

  private webhookUrl(): string {
    return this.options_.webhookUrl || `${String(this.options_.backendUrl).replace(/\/+$/, "")}/hooks/payment/arionpay_arionpay`
  }

  /** Short id of this shop, so two shops on one ArionPay store never touch each other's payments. */
  private siteId(): string {
    return createHash("sha256").update(`medusa|${this.webhookUrl()}|${this.options_.apiKey}`).digest("hex").slice(0, 12)
  }

  private async newInvoice(sessionId: string, amount: string, currency: string, attempt: number, data: SessionData): Promise<SessionData> {
    if (!CURRENCIES.includes(currency)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `ArionPay does not take payments in ${currency}.`)
    }
    const returnUrl = String(data.return_url || this.options_.storefrontUrl || "")
    const test = this.isTest()
    const created = await this.client_.createInvoice({
      amount,
      currency,
      orderId: sessionId,
      description: `Order ${sessionId}`,
      ...(returnUrl ? { successUrl: returnUrl, cancelUrl: String(data.cancel_url || returnUrl) } : {}),
      callbackUrl: this.webhookUrl(),
      metadata: { medusa_session_id: sessionId, medusa_amount: amount, medusa_currency: currency, medusa_site: this.siteId(), platform: "medusa" },
      idempotencyKey: `medusa-${this.siteId()}-${sessionId}-${amount.replace(".", "")}${currency}${test ? "-test" : ""}-${attempt}`,
      test,
    })
    return {
      ...data, session_id: sessionId, invoice_id: created.id, invoice_url: created.invoiceUrl, amount, currency, test, attempt,
    }
  }

  async initiatePayment({ amount, currency_code, data }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const d = (data ?? {}) as SessionData
    const sessionId = String(d.session_id ?? "")
    if (!sessionId) throw new MedusaError(MedusaError.Types.INVALID_DATA, "ArionPay: missing payment session id.")
    const next = await this.newInvoice(sessionId, money(amount), currency_code.toUpperCase(), 1, d)
    return { id: next.invoice_id!, data: next, status: PaymentSessionStatus.PENDING }
  }

  /** The cart total changed after the session was made: the next invoice uses the new total. */
  async updatePayment({ amount, currency_code, data }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const d = (data ?? {}) as SessionData
    const total = money(amount)
    const currency = currency_code.toUpperCase()
    if (d.invoice_id && d.amount === total && d.currency === currency) return { data: d }
    const next = await this.newInvoice(String(d.session_id), total, currency, Number(d.attempt ?? 1) + 1, d)
    return { data: next, status: PaymentSessionStatus.PENDING }
  }

  /** Checks the invoice with ArionPay (never the customer's word): paid for this session's amount -> captured. */
  async authorizePayment({ data }: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const d = (data ?? {}) as SessionData
    if (!d.invoice_id) return { status: PaymentSessionStatus.ERROR, data: d }
    const inv = await this.client_.getInvoice(d.invoice_id)
    if (inv.status === "paid") {
      const problem = this.mismatch(inv, d)
      if (problem) {
        this.logger_.warn(`ArionPay: invoice ${inv.id} is paid but ${problem}; session ${d.session_id} NOT authorized. Check it in your ArionPay dashboard.`)
        return { status: PaymentSessionStatus.ERROR, data: { ...d, arionpay_problem: problem } }
      }
      return { status: PaymentSessionStatus.CAPTURED, data: { ...d, paid_invoice: inv.id, ...this.paidNotes(inv) } }
    }
    return { status: PaymentSessionStatus.PENDING, data: { ...d, invoice_status: inv.status } }
  }

  /** Crypto payments are final: nothing more to capture. */
  async capturePayment({ data }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: data ?? {} }
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const d = (data ?? {}) as SessionData
    if (!d.invoice_id) return { status: PaymentSessionStatus.PENDING, data: d }
    const inv = await this.client_.getInvoice(d.invoice_id)
    if (inv.status === "paid") return { status: this.mismatch(inv, d) ? PaymentSessionStatus.ERROR : PaymentSessionStatus.CAPTURED, data: d }
    if (inv.status === "expired") return { status: PaymentSessionStatus.CANCELED, data: d }
    return { status: PaymentSessionStatus.PENDING, data: d }
  }

  async retrievePayment({ data }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const d = (data ?? {}) as SessionData
    if (!d.invoice_id) return { data: d }
    const inv = await this.client_.getInvoice(d.invoice_id)
    return { data: { ...d, invoice_status: inv.status } }
  }

  /** Nothing to cancel at ArionPay: an unpaid invoice simply expires (a late payment is then logged, not taken). */
  async cancelPayment({ data }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: data ?? {} }
  }

  async deletePayment({ data }: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: data ?? {} }
  }

  /** Records the refund in Medusa. The crypto itself is sent back from your own wallet (ArionPay never holds it). */
  async refundPayment({ amount, data }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const d = (data ?? {}) as SessionData
    const refunds = Array.isArray(d.refunds) ? (d.refunds as unknown[]) : []
    this.logger_.info(`ArionPay: refund of ${money(amount)} ${d.currency ?? ""} recorded for invoice ${d.invoice_id}. Send it from your own wallet.`)
    return { data: { ...d, refunds: [...refunds, { amount: money(amount), at: new Date().toISOString() }] } }
  }

  /** POST /hooks/payment/arionpay_arionpay (Medusa answers 200 at once and calls this in the background). */
  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    const header = String((payload.headers as Record<string, unknown>)["arionpay-signature"] ?? "")
    let event
    try {
      event = verifyWebhook(payload.rawData as Buffer | string, header, this.options_.webhookSecret)
    } catch (e) {
      this.logger_.warn(`ArionPay webhook refused: ${(e as Error).message}`)
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    if (isTestEvent(event)) {
      this.logger_.info(`ArionPay test webhook received (${event.type}). Nothing changed.`)
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    const inv = webhookInvoice(event.data.invoice)
    const sessionId = String(inv.metadata.medusa_session_id ?? "")
    if (!sessionId || inv.metadata.medusa_site !== this.siteId()) return { action: PaymentActions.NOT_SUPPORTED }
    if (inv.test !== this.isTest()) {
      this.logger_.warn(`ArionPay webhook for invoice ${inv.id}: test/live mode differs from this shop; ignored.`)
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    const meta = { amount: String(inv.metadata.medusa_amount ?? ""), currency: String(inv.metadata.medusa_currency ?? "") }
    const amount = new BigNumber(Number(meta.amount || 0))
    switch (event.type) {
      case "invoice.paid": {
        const problem = this.mismatch(inv, meta)
        if (problem) {
          this.logger_.warn(`ArionPay: invoice ${inv.id} is paid but ${problem}; session ${sessionId} NOT authorized. Check it in your ArionPay dashboard.`)
          return { action: PaymentActions.NOT_SUPPORTED }
        }
        // Medusa now authorizes the session (authorizePayment checks the invoice again with ArionPay) and completes the cart.
        return { action: PaymentActions.SUCCESSFUL, data: { session_id: sessionId, amount } }
      }
      case "invoice.pending":
      case "invoice.partial":
        return { action: PaymentActions.PENDING, data: { session_id: sessionId, amount } }
      default:
        this.logger_.info(`ArionPay ${event.type} for invoice ${inv.id} (session ${sessionId}): no change.`)
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }

  /** Why a paid invoice does not fit the session ("" when it does). */
  private mismatch(inv: Invoice, d: { amount?: string; currency?: string; test?: boolean; session_id?: string }): string {
    const paid = inv.amountFiat === null ? "" : inv.amountFiat.toFixed(2)
    if (paid !== d.amount || inv.currency.toUpperCase() !== String(d.currency ?? "").toUpperCase()) {
      return `its amount (${paid} ${inv.currency}) is not the session's (${d.amount} ${d.currency})`
    }
    if (d.test !== undefined && inv.test !== Boolean(d.test)) return "its test/live mode differs"
    if (inv.metadata.medusa_site !== this.siteId()) return "it belongs to another shop"
    if (d.session_id !== undefined && inv.metadata.medusa_session_id !== d.session_id) return "it belongs to another payment session"
    return ""
  }

  private paidNotes(inv: Invoice): Record<string, unknown> {
    return {
      paid_asset: inv.asset, paid_network: inv.network, paid_crypto: inv.paidCrypto,
      paid_late: inv.late || undefined, overpaid: inv.overpaid || undefined, underpaid_within_tolerance: inv.underpaidWithinTolerance || undefined,
      accepted_by_hand: inv.manual || undefined,
    }
  }
}

export default ArionPayProviderService
