/**
 * The CHIP Collect tool set.
 *
 * Eleven tools cover the whole documented workflow: create a checkout, read its
 * authoritative status, cancel it, refund it, capture or release held funds, run a
 * recurring charge, discover which payment methods a brand can offer, read the
 * account balance, verify a callback signature, and — for the long tail — issue any
 * other operation from the documented endpoint allowlist.
 *
 * Amounts are always integers in the currency's minor unit (sen for MYR): `100` is
 * RM 1.00, `1000` is RM 10.00. Amounts are never floats and never major units.
 *
 * @module dsh-plugin-chip-collect/tools
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ChipCollectError, unsupportedEndpointError } from "./errors.js";
import { describeEndpoints, matchEndpoint, normalizePath } from "./endpoints.js";
import { describeVerification, parsePublicKey, verifyCallback } from "./signature.js";
import {
  compact,
  formatJson,
  formatOperation,
  formatPurchase,
  projectOperation,
  projectPurchase,
} from "./views.js";

/**
 * Every value `payment_method_whitelist` accepts, verbatim from the OpenAPI enum.
 *
 * `card`, `ewallet`, `fpx_b2c`, `razer`, and `american_express` are **not** valid
 * here even though CHIP's own transaction records use some of those words.
 */
export const PAYMENT_METHODS = Object.freeze([
  "fpx",
  "fpx_b2b1",
  "crypto_coin",
  "dnqr",
  "duitnow_qr",
  "maestro",
  "mastercard",
  "mpgs_apple_pay",
  "mpgs_google_pay",
  "razer_atome",
  "razer_grabpay",
  "razer_maybankqr",
  "razer_shopeepay",
  "razer_tng",
  "shopee_pay",
  "visa",
]);

/** Request `platform` values the OpenAPI enum allows. */
export const PLATFORMS = Object.freeze(["web", "api", "ios", "android", "macos", "windows"]);

/** The 21 purchase statuses, listed for the model's benefit. */
const STATUS_HINT = "created, sent, viewed, error, cancelled, overdue, expired, blocked, hold, released, "
  + "pending_release, pending_capture, preauthorized, paid, pending_execute, pending_charge, cleared, "
  + "settled, chargeback, pending_refund, refunded";

/**
 * Every tool this plugin registers, in registration order.
 *
 * Exported so a test or an operator can assert the plugin's whole surface without
 * scraping the prompt or the tool list.
 */
export const TOOL_NAMES = Object.freeze([
  "chip_collect_create_purchase",
  "chip_collect_get_purchase",
  "chip_collect_cancel_purchase",
  "chip_collect_refund_purchase",
  "chip_collect_capture_purchase",
  "chip_collect_release_purchase",
  "chip_collect_charge_recurring",
  "chip_collect_list_payment_methods",
  "chip_collect_get_account_balance",
  "chip_collect_verify_webhook_signature",
  "chip_collect_api_request",
]);

/**
 * The shared output schema for a projected purchase.
 *
 * Every field is optional except `id` and `status`: the projection drops nullish
 * values rather than inventing empty strings, so a caller must not assume a key is
 * present. `status` is a plain string rather than an enum so a status CHIP adds
 * later cannot fail the tool.
 */
const PURCHASE_VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "A CHIP Collect purchase, reduced to the fields that drive a decision.",
  properties: {
    id: { type: "string", required: true, description: "Purchase UUID." },
    type: { type: "string", description: 'Object type; always "purchase".' },
    status: { type: "string", required: true, description: `Purchase status. One of: ${STATUS_HINT}.` },
    isTest: { type: "boolean", description: "True when the purchase was created with a test-mode key." },
    brandId: { type: "string", description: "Brand UUID the purchase belongs to." },
    reference: { type: "string", description: "Your own invoice reference." },
    referenceGenerated: { type: "string", description: 'CHIP-generated invoice number, for example "CH0001".' },
    currency: { type: "string", description: "ISO 4217 currency code." },
    total: { type: "integer", description: "Total in minor units (sen). RM 10.00 is 1000." },
    totalOverride: { type: "integer", description: "The overridden total in minor units, when one was set." },
    refundableAmount: { type: "integer", description: "Amount still refundable, in minor units." },
    refundAvailability: { type: "string", description: "all, full_only, partial_only, pis_all, pis_partial, or none." },
    checkoutUrl: { type: "string", description: "Hosted CHIP payment page. Supports ?preferred={method} and ?active={method}." },
    directPostUrl: { type: "string", description: "Server-to-server card form action, when the merchant account enables it." },
    invoiceUrl: { type: "string", description: "Hosted invoice page." },
    clientEmail: { type: "string" },
    clientName: { type: "string" },
    clientPhone: { type: "string" },
    paymentMethod: { type: "string", description: "Payment method actually used, once a payment was attempted." },
    paymentFlow: { type: "string", description: "How the payment was initiated, for example api, payform, or link." },
    skipCapture: { type: "boolean", description: "True when funds are only authorized and still need a capture or release." },
    forceRecurring: { type: "boolean" },
    isRecurringToken: { type: "boolean", description: "True when a recurring token is stored for this purchase." },
    recurringToken: { type: "string", description: "The stored recurring token. Treat as a payment credential and never echo it to a user." },
    createdOn: { type: "string", description: "ISO 8601 timestamp." },
    updatedOn: { type: "string", description: "ISO 8601 timestamp." },
    due: { type: "string", description: "ISO 8601 due timestamp, when set." },
    paidOn: { type: "string", description: "ISO 8601 payment timestamp, when paid." },
    notes: { type: "string" },
    products: {
      type: "array",
      description: "Line items, in minor units.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          price: { type: "integer" },
          quantity: { type: "string" },
        },
      },
    },
    statusHistory: {
      type: "array",
      description: "Every status the purchase has passed through, oldest first.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          at: { type: "string", description: "ISO 8601 timestamp." },
        },
      },
    },
  },
};

/**
 * Build the output contract for a tool that returns one projected purchase.
 *
 * @param format - Renders the projection into the tool's text result.
 * @returns The `output` member of a tool definition.
 */
function purchaseOutput(format) {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { purchase: { ...PURCHASE_VIEW_SCHEMA, required: true } },
    },
    render: (_args, value) => [{ type: "text", text: format(value.purchase) }],
  };
}

/**
 * Build the output contract for a tool that returns a refund/capture/release/charge
 * result, which is either a `Payment` or a still-processing `Purchase`.
 *
 * @returns The `output` member of a tool definition.
 */
function operationOutput() {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", required: true, description: '"payment" when the operation completed, "purchase" while it is still in flight.' },
        payment: {
          type: "object",
          additionalProperties: false,
          description: "Present when kind is payment.",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            paymentType: { type: "string", description: "purchase, purchase_charge, payout, bank_payment, refund, or custom." },
            amount: { type: "integer", description: "Minor units." },
            currency: { type: "string" },
            netAmount: { type: "integer" },
            feeAmount: { type: "integer" },
            description: { type: "string" },
            isOutgoing: { type: "boolean" },
            paidOn: { type: "string", description: "ISO 8601 timestamp." },
            reference: { type: "string" },
            referenceGenerated: { type: "string" },
            relatedTo: { type: "string", description: '"purchase/<id>" for a refund.' },
            isTest: { type: "boolean" },
          },
        },
        purchase: { ...PURCHASE_VIEW_SCHEMA, description: "Present when kind is purchase." },
      },
    },
    render: (_args, value) => [{ type: "text", text: formatOperation(value) }],
  };
}

/**
 * Merge caller-supplied extra fields into a request object.
 *
 * The typed tool arguments cover the fields a payment flow normally needs; these
 * pass-throughs let a caller reach the rest of a CHIP request schema without the
 * plugin inventing a parameter for every optional field.
 *
 * @param base - The object built from typed arguments.
 * @param extra - Caller-supplied additional fields, or nothing.
 * @param label - Argument name, used in the error message.
 * @returns The merged object.
 * @throws {ChipCollectError} When `extra` is not a JSON object.
 */
function mergeExtra(base, extra, label) {
  if (extra === undefined || extra === null) return base;
  if (typeof extra !== "object" || Array.isArray(extra)) {
    throw new ChipCollectError(`chip-collect: "${label}" must be a JSON object`, { code: "INVALID_ARGUMENT" });
  }
  return { ...base, ...extra };
}

/**
 * Assemble the `POST /purchases/` request body.
 *
 * @param args - Validated tool arguments.
 * @param config - Resolved plugin configuration.
 * @returns The request body.
 * @throws {ChipCollectError} When no brand id is available.
 */
function buildPurchaseBody(args, config) {
  const brandId = args.brandId ?? config.brandId;
  if (typeof brandId !== "string" || brandId.length === 0) {
    throw new ChipCollectError(
      "chip-collect: creating a purchase needs a brand id. Pass \"brandId\", or set \"brandId\" in the chip-collect config. "
        + "Find yours at https://portal.chip-in.asia/collect/developers/brands.",
      { code: "MISSING_BRAND_ID" },
    );
  }
  const client = mergeExtra(compact({
    email: args.email,
    full_name: args.clientName,
    phone: args.clientPhone,
  }), args.clientFields, "clientFields");
  const products = (args.products ?? []).map((product) => compact({
    name: product.name,
    price: product.price,
    quantity: product.quantity,
    discount: product.discount,
    tax_percent: product.taxPercent,
    category: product.category,
  }));
  const purchase = mergeExtra(compact({
    currency: args.currency ?? config.currency,
    products,
    language: args.language,
    notes: args.notes,
    debt: args.debt,
    total_override: args.totalOverride,
    due_strict: args.dueStrict,
    email_message: args.emailMessage,
    metadata: args.metadata,
  }), args.purchaseFields, "purchaseFields");
  return {
    brandId,
    body: compact({
      client,
      purchase,
      brand_id: brandId,
      reference: args.reference,
      due: args.due,
      issued: args.issued,
      platform: args.platform,
      send_receipt: args.sendReceipt,
      skip_capture: args.skipCapture,
      force_recurring: args.forceRecurring,
      payment_method_whitelist: args.paymentMethodWhitelist,
      success_redirect: args.successRedirect,
      failure_redirect: args.failureRedirect,
      cancel_redirect: args.cancelRedirect,
      success_callback: args.successCallback,
      tags: args.tags,
      creator_agent: args.creatorAgent,
    }),
  };
}

/**
 * Register every CHIP Collect tool on the calling context.
 *
 * @param ctx - Plugin context whose `tools` registry receives the definitions.
 * @param api - The API surface built by the plugin.
 * @param api.request - Issues one allowlisted request.
 * @param api.config - Resolved plugin configuration.
 * @param api.toolTimeoutMs - Cooperative per-tool timeout budget.
 */
export function registerChipCollectTools(ctx, api) {
  const { config, toolTimeoutMs } = api;
  const brandIdFor = (value) => value ?? config.brandId;

  // --- Create a purchase ---------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_create_purchase",
    description:
      "Create a CHIP Collect purchase and return its hosted checkout_url, which is the link you send the customer to pay. "
      + "Supports FPX, DuitNow QR (dnqr), cards, ShopeePay, Razer/GrabPay e-wallets, Apple/Google Pay, Atome, and crypto, "
      + "depending on what the brand has enabled. All amounts are integers in the currency's minor unit: 1000 is RM 10.00. "
      + "The returned status is normally \"created\"; the purchase is only paid once the customer completes the checkout. "
      + "Never treat a redirect URL or a query parameter as proof of payment — call chip_collect_get_purchase to confirm server-side.",
    parameters: {
      email: { type: "string", required: true, description: "Customer email address; CHIP requires it on every purchase." },
      products: {
        type: "array",
        required: true,
        description: "Line items; at least one. Prices are in minor units (sen).",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true, description: "Product name, up to 256 characters." },
            price: { type: "integer", required: true, description: "Unit price in minor units. RM 10.00 is 1000." },
            quantity: { type: "string", description: 'Quantity as a string; defaults to "1".' },
            discount: { type: "integer", description: "Per-line discount in minor units." },
            taxPercent: { type: "string", description: 'Tax percentage as a string, for example "6".' },
            category: { type: "string", description: "Product category label." },
          },
        },
      },
      brandId: { type: "string", description: "Brand UUID; falls back to the configured brandId." },
      currency: { type: "string", description: 'ISO 4217 code. Defaults to the configured currency, normally "MYR".' },
      clientName: { type: "string", description: "Customer full name." },
      clientPhone: { type: "string", description: "Customer phone number in E.164-ish form, for example +60123456789." },
      clientFields: { type: "json", description: "Extra ClientDetailsBody fields merged into the client object, for example legal_name, registration_number, tax_number, street_address, country, city, zip_code, state, cc, bcc." },
      purchaseFields: { type: "json", description: "Extra PurchaseDetailsBody fields merged into the purchase object, for example subtotal_override, shipping_options, request_client_details, payment_method_details." },
      reference: { type: "string", description: "Your own invoice reference. Also settable per purchase as \"reference\"." },
      due: { type: "integer", description: "Payment deadline as a unix timestamp in seconds." },
      issued: { type: "string", description: 'Display-only issue date, "YYYY-MM-DD".' },
      metadata: { type: "json", description: "Arbitrary metadata stored on the purchase." },
      language: { type: "string", description: 'ISO 639-1 language for the checkout page, for example "en".' },
      notes: { type: "string", description: "Notes shown on the invoice, up to 10000 characters." },
      debt: { type: "integer", description: "Amount in minor units added to (or, if negative, subtracted from) the total." },
      totalOverride: { type: "integer", description: "Force the total, in minor units. 0 together with skipCapture requests a card preauthorization." },
      dueStrict: { type: "boolean", description: "true makes the purchase expire once due has passed; false leaves it payable as overdue." },
      emailMessage: { type: "string", description: "Custom message in the invoice email, up to 512 characters." },
      sendReceipt: { type: "boolean", description: "Email a receipt to the customer once the purchase is paid." },
      skipCapture: { type: "boolean", description: "Cards only: authorize and hold instead of charging, so you must capture or release afterwards." },
      forceRecurring: { type: "boolean", description: "Force the payment credentials to be saved for recurring charges." },
      paymentMethodWhitelist: {
        type: "array",
        description: "Restrict the checkout to these methods. Omit to offer everything the brand has enabled.",
        items: { type: "string", enum: PAYMENT_METHODS },
      },
      successRedirect: { type: "string", description: "URL to send the customer to after a successful payment." },
      failureRedirect: { type: "string", description: "URL to send the customer to after a failed payment." },
      cancelRedirect: { type: "string", description: "URL to send the customer to after cancelling. It does not cancel the purchase." },
      successCallback: { type: "string", description: "Server URL that receives the signed Purchase JSON once the payment succeeds." },
      platform: { type: "string", enum: PLATFORMS, description: "Platform label recorded on the purchase. Defaults to \"api\"." },
      tags: { type: "array", items: { type: "string" }, description: "Tags to attach to the purchase." },
      creatorAgent: { type: "string", description: "Free-text creator label, up to 32 characters." },
    },
    output: purchaseOutput((purchase) => [
      `Purchase created — status **${purchase.status}**.`,
      "",
      formatPurchase(purchase),
      "",
      purchase.checkoutUrl === undefined
        ? "No checkout_url came back; the purchase may not be payable as configured. Re-read it with chip_collect_get_purchase."
        : "Send the customer to the checkout URL above. Payment is only confirmed by chip_collect_get_purchase, never by the redirect alone.",
    ].join("\n")),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { body } = buildPurchaseBody(args, config);
      const raw = await api.request("POST", "/purchases/", { body, signal: exec.signal });
      return { purchase: projectPurchase(raw) };
    },
  }));

  // --- Read a purchase -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_get_purchase",
    description:
      "Read one CHIP Collect purchase by id. This is the authoritative, server-side status check: CHIP explicitly "
      + "recommends calling it after a return-URL redirect instead of trusting anything the browser sends back. "
      + "Use it to answer \"did this order actually get paid?\" before releasing goods or services.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "Purchase UUID returned by chip_collect_create_purchase." },
    },
    output: purchaseOutput((purchase) => formatPurchase(purchase)),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const raw = await api.request("GET", `/purchases/${encodeURIComponent(args.purchaseId)}/`, { signal: exec.signal });
      return { purchase: projectPurchase(raw) };
    },
  }));

  // --- Cancel --------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_cancel_purchase",
    description:
      "Cancel a CHIP Collect purchase that is still payable. Once a purchase is paid this fails; refund it instead. "
      + "Cancelling does not undo a payment and does not by itself stop an invoice email that was already sent.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "Purchase UUID to cancel." },
    },
    output: purchaseOutput((purchase) => `Purchase cancelled — status **${purchase.status}**.\n\n${formatPurchase(purchase)}`),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const raw = await api.request("POST", `/purchases/${encodeURIComponent(args.purchaseId)}/cancel/`, { signal: exec.signal });
      return { purchase: projectPurchase(raw) };
    },
  }));

  // --- Refund --------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_refund_purchase",
    description:
      "Refund a paid CHIP Collect purchase, in full or in part. Omit \"amount\" for a full refund; otherwise pass minor units "
      + "(100 for RM 1.00), never more than the purchase's refundableAmount. Check refundAvailability first with "
      + "chip_collect_get_purchase. A refund may complete immediately (a Payment comes back) or still be in flight at the "
      + "acquirer (the purchase comes back with status pending_refund); in the second case the final outcome arrives as a "
      + "payment.refunded webhook.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "Purchase UUID to refund." },
      amount: { type: "integer", description: "Partial refund amount in minor units. Omit for a full refund." },
      idempotencyKey: { type: "string", description: "Idempotency key; one is generated automatically when omitted." },
    },
    output: operationOutput(),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const body = args.amount === undefined ? undefined : { amount: args.amount };
      const raw = await api.request("POST", `/purchases/${encodeURIComponent(args.purchaseId)}/refund/`, {
        body,
        idempotencyKey: args.idempotencyKey,
        signal: exec.signal,
      });
      return projectOperation(raw);
    },
  }));

  // --- Capture -------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_capture_purchase",
    description:
      "Capture funds that a skip_capture purchase is holding, moving it to paid. Pass \"amount\" for a partial capture in "
      + "minor units, or omit it to capture the full held amount. Only valid while the purchase is in a hold state; use "
      + "chip_collect_get_purchase to confirm before capturing, and chip_collect_release_purchase to give the money back instead.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "Purchase UUID whose held funds should be captured." },
      amount: { type: "integer", description: "Partial capture amount in minor units. Omit to capture everything held." },
      idempotencyKey: { type: "string", description: "Idempotency key; one is generated automatically when omitted." },
    },
    output: operationOutput(),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const body = args.amount === undefined ? undefined : { amount: args.amount };
      const raw = await api.request("POST", `/purchases/${encodeURIComponent(args.purchaseId)}/capture/`, {
        body,
        idempotencyKey: args.idempotencyKey,
        signal: exec.signal,
      });
      return projectOperation(raw);
    },
  }));

  // --- Release -------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_release_purchase",
    description:
      "Release funds a skip_capture purchase is holding, returning them to the customer's card. Use this instead of a refund "
      + "when the money was only authorized and never taken. Takes no body.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "Purchase UUID whose held funds should be released." },
      idempotencyKey: { type: "string", description: "Idempotency key; one is generated automatically when omitted." },
    },
    output: operationOutput(),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const raw = await api.request("POST", `/purchases/${encodeURIComponent(args.purchaseId)}/release/`, {
        idempotencyKey: args.idempotencyKey,
        signal: exec.signal,
      });
      return projectOperation(raw);
    },
  }));

  // --- Recurring charge ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_charge_recurring",
    description:
      "Charge a saved recurring token by POSTing to the purchase that owns it. The recurring token is a payment credential: "
      + "it can move money without the customer present, so never print it in user-facing text or write it into a file. "
      + "Obtain it from a purchase whose isRecurringToken is true (see chip_collect_get_purchase) or from the client's "
      + "recurring-token list. A successful charge moves the purchase to pending_charge at the acquirer.",
    parameters: {
      purchaseId: { type: "string", required: true, description: "UUID of the purchase that owns the recurring token." },
      recurringToken: { type: "string", required: true, description: "The stored recurring token to charge." },
      idempotencyKey: { type: "string", description: "Idempotency key; one is generated automatically when omitted." },
    },
    output: operationOutput(),
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const raw = await api.request("POST", `/purchases/${encodeURIComponent(args.purchaseId)}/charge/`, {
        body: { recurring_token: args.recurringToken },
        idempotencyKey: args.idempotencyKey,
        signal: exec.signal,
      });
      return projectOperation(raw);
    },
  }));

  // --- Payment methods -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_list_payment_methods",
    description:
      "List the payment methods a brand can actually offer for a given amount, as method codes usable in "
      + "payment_method_whitelist or as ?preferred={method} on the checkout URL. CHIP strongly recommends always sending "
      + "amount: without it, FPX, DuitNow QR, ShopeePay and most other methods are hidden because they have minimums. "
      + "RM 10 (1000) is a safe probe value that clears every minimum.",
    parameters: {
      brandId: { type: "string", description: "Brand UUID; falls back to the configured brandId." },
      currency: { type: "string", description: 'ISO 4217 code; CHIP only accepts "MYR" today. Defaults to the configured currency.' },
      amount: { type: "integer", description: "Amount in minor units used for the availability lookup. Defaults to 1000 (RM 10.00)." },
      country: { type: "string", description: "Customer country, to narrow the result." },
      language: { type: "string", description: "Language for the returned display names." },
      recurring: { type: "boolean", description: "Only list methods usable for recurring charges." },
      skipCapture: { type: "boolean", description: "Only list methods that support authorization without capture." },
      preauthorization: { type: "boolean", description: "Only list methods that support preauthorization." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          availablePaymentMethods: {
            type: "array",
            required: true,
            description: "Payment method codes available for this brand, currency, and amount.",
            items: { type: "string" },
          },
          cardMethods: {
            type: "array",
            description: "Which of the available methods are card methods.",
            items: { type: "string" },
          },
          paymentMethods: { type: "json", description: "CHIP's full response, including names, logos, and by_country groupings." },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `${value.availablePaymentMethods.length} payment method(s) available:`,
          ...value.availablePaymentMethods.map((method) => `- \`${method}\``),
          value.cardMethods === undefined ? "" : `\nCard methods: ${value.cardMethods.join(", ")}`,
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const brandId = brandIdFor(args.brandId);
      if (typeof brandId !== "string" || brandId.length === 0) {
        throw new ChipCollectError(
          "chip-collect: listing payment methods needs a brand id. Pass \"brandId\" or set \"brandId\" in the chip-collect config.",
          { code: "MISSING_BRAND_ID" },
        );
      }
      const raw = await api.request("GET", "/payment_methods/", {
        query: {
          brand_id: brandId,
          currency: args.currency ?? config.currency,
          amount: args.amount ?? 1_000,
          country: args.country,
          language: args.language,
          recurring: args.recurring,
          skip_capture: args.skipCapture,
          preauthorization: args.preauthorization,
        },
        signal: exec.signal,
      });
      const available = Array.isArray(raw?.available_payment_methods) ? raw.available_payment_methods : [];
      return compact({
        availablePaymentMethods: available,
        cardMethods: Array.isArray(raw?.card_methods) ? raw.card_methods : undefined,
        paymentMethods: raw ?? undefined,
      });
    },
  }));

  // --- Account balance -----------------------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_get_account_balance",
    description:
      "Read the CHIP Collect company balance, grouped by currency. All filter arguments are optional; omit them for the "
      + "whole account. Amounts come back in minor units.",
    parameters: {
      currency: { type: "string", description: "Restrict the balance to one ISO 4217 currency." },
      brandId: { type: "string", description: "Restrict the balance to one brand UUID." },
      from: { type: "integer", description: "Read the balance as it stood at this unix timestamp in seconds." },
      paymentMethod: { type: "string", description: "Restrict to one payment method code." },
      product: { type: "string", description: "Restrict to one product." },
      flow: { type: "string", description: "Restrict to one transaction flow." },
      country: { type: "string", description: "Restrict to one customer country." },
      terminalUid: { type: "string", description: "Restrict to one terminal uid." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          balance: { type: "json", required: true, description: "CHIP's BalanceByCurrency object, in minor units." },
        },
      },
      render: (_args, value) => [{ type: "text", text: `CHIP Collect balance, in minor units:\n\n${formatJson(value.balance)}` }],
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const raw = await api.request("GET", "/account/json/balance/", {
        query: {
          currency: args.currency,
          brand_id: brandIdFor(args.brandId),
          from: args.from,
          payment_method: args.paymentMethod,
          product: args.product,
          flow: args.flow,
          country: args.country,
          terminal_uid: args.terminalUid,
        },
        signal: exec.signal,
      });
      return { balance: raw };
    },
  }));

  // --- Verify a callback signature ----------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_verify_webhook_signature",
    description:
      "Verify a CHIP Collect callback by its X-Signature header, which is a base64 RSA PKCS#1 v1.5 signature over the "
      + "SHA-256 digest of the raw request body. Pass the body EXACTLY as received — re-serializing parsed JSON changes "
      + "whitespace and always fails verification. Success callbacks (success_callback) are verified with the company key "
      + "from GET /public_key/, which this tool fetches when publicKey is omitted; webhook subscriptions use their own "
      + "publicKey instead. A false result means the delivery must be treated as untrusted.",
    parameters: {
      signature: { type: "string", required: true, description: "The X-Signature header value, base64-encoded." },
      body: { type: "string", required: true, description: "The raw request body, byte-for-byte as received." },
      publicKey: { type: "string", description: "PEM public key. Omit to fetch the company key from GET /public_key/." },
      eventType: { type: "string", description: "The payload's event_type, used only to phrase the result." },
      payload: { type: "json", description: "The parsed payload, echoed back once verification succeeds." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          verified: { type: "boolean", required: true, description: "True only when the signature matches the body." },
          message: { type: "string", required: true, description: "What the verdict means and what to do next." },
          eventType: { type: "string", description: "The event_type that was reported or read from the payload." },
          payload: { type: "json", description: "The parsed payload, present only when verification succeeded." },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          value.message,
          value.verified && value.payload !== undefined ? `\n\`\`\`json\n${JSON.stringify(value.payload, undefined, 2)}\n\`\`\`` : "",
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const eventType = args.eventType ?? args.payload?.event_type;
      const key = args.publicKey === undefined
        ? await fetchCompanyPublicKey(api, exec.signal)
        : parsePublicKey(args.publicKey);
      const verified = verifyCallback({ signature: args.signature, body: args.body, publicKey: key });
      return compact({
        verified,
        message: describeVerification(verified, typeof eventType === "string" ? eventType : undefined),
        eventType: typeof eventType === "string" ? eventType : undefined,
        payload: verified ? args.payload : undefined,
      });
    },
  }));

  // --- Generic documented request -----------------------------------------
  ctx.tools.register(defineTool({
    name: "chip_collect_api_request",
    description:
      "Call any other documented CHIP Collect endpoint that has no dedicated tool: clients, webhooks, company statements, "
      + "mark_as_paid, resend_invoice, delete_recurring_token, turnover. The method and path are matched against the "
      + "documented operation list before anything is sent, so a path the CHIP OpenAPI spec does not define is rejected "
      + "rather than guessed at. Paths are plural with a trailing slash, for example /clients/{id}/ or /webhooks/.",
    parameters: {
      method: { type: "string", required: true, enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
      path: { type: "string", required: true, description: "Documented path with concrete ids, for example /webhooks/ or /clients/abc-uuid/recurring_tokens/." },
      query: { type: "json", description: "Query parameters as an object; array values repeat the key." },
      body: { type: "json", description: "JSON request body for POST, PUT, and PATCH." },
      idempotencyKey: { type: "string", description: "Idempotency key for a write; one is generated automatically when omitted." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", required: true, description: "The documented operation id that matched." },
          request: { type: "string", required: true, description: "The method and path that were sent." },
          summary: { type: "string", required: true, description: "What the operation does." },
          result: { type: "json", required: true, description: "CHIP's JSON response body." },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `${value.summary}\n\n\`${value.request}\`\n\n${formatJson(value.result)}`,
      }],
    },
    timeoutMs: toolTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const matched = matchEndpoint(args.method, args.path);
      if (matched === undefined) {
        throw unsupportedEndpointError(String(args.method).toUpperCase(), String(args.path), describeEndpoints());
      }
      const query = args.query === undefined || args.query === null
        ? undefined
        : assertObject(args.query, "query");
      const body = args.body === undefined || args.body === null
        ? undefined
        : assertObject(args.body, "body");
      const result = await api.request(matched.method, normalizePath(args.path), {
        query,
        body,
        idempotencyKey: args.idempotencyKey,
        signal: exec.signal,
      });
      return {
        operation: matched.id,
        request: `${matched.method} ${matched.path}`,
        summary: matched.summary,
        result: result ?? null,
      };
    },
  }));
}

/**
 * Reject a non-object JSON argument early, with the argument's own name in the message.
 *
 * @param value - The argument value.
 * @param label - Argument name.
 * @returns The same value, so it can be used inline.
 * @throws {ChipCollectError} When the value is not a JSON object.
 */
function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChipCollectError(`chip-collect: "${label}" must be a JSON object`, { code: "INVALID_ARGUMENT" });
  }
  return value;
}

/**
 * Fetch and parse the company callback public key.
 *
 * @param api - The API surface built by the plugin.
 * @param signal - Cancellation signal from the tool execution.
 * @returns A parsed public key object.
 * @throws {ChipCollectError} When the response holds no usable key.
 */
async function fetchCompanyPublicKey(api, signal) {
  const raw = await api.request("GET", "/public_key/", { signal });
  const text = typeof raw === "string" ? raw : raw?.public_key ?? raw?.key;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ChipCollectError(
      "chip-collect: GET /public_key/ returned no PEM key; pass \"publicKey\" explicitly instead.",
      { code: "MISSING_PUBLIC_KEY" },
    );
  }
  return parsePublicKey(text);
}
