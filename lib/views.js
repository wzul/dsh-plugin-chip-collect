/**
 * Response projections and text formatting for tool results.
 *
 * CHIP's `Purchase` object is very wide — status history, issuer details,
 * transaction attempts, referral fields — and most of it is noise for an agent
 * deciding what to do next. These helpers reduce a response to the fields that
 * drive a decision, drop nullish ones so the shape stays honest, and render a
 * summary a human can read at a glance.
 *
 * @module dsh-plugin-chip-collect/views
 */

/**
 * Drop `undefined` and `null` entries so an absent field is simply absent.
 *
 * @param object - Candidate projection.
 * @returns A new object without nullish values.
 */
export function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * Convert a CHIP unix-seconds timestamp to ISO 8601.
 *
 * @param value - Unix seconds, an existing ISO string, or nothing.
 * @returns An ISO 8601 string, or `undefined` when there is no usable value.
 */
export function toIso(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1_000).toISOString();
}

/**
 * Reduce a CHIP `Purchase` to the fields worth showing.
 *
 * @param raw - The `Purchase` object as returned by any purchase endpoint.
 * @returns A compact, nullish-free projection.
 */
export function projectPurchase(raw) {
  const purchase = raw?.purchase ?? {};
  const payment = raw?.payment ?? {};
  const products = Array.isArray(purchase.products)
    ? purchase.products.map((product) => compact({
      name: product?.name,
      price: product?.price,
      quantity: product?.quantity,
    }))
    : undefined;
  const statusHistory = Array.isArray(raw?.status_history)
    ? raw.status_history.map((entry) => compact({
      status: entry?.status,
      at: toIso(entry?.timestamp),
    }))
    : undefined;
  return compact({
    id: raw?.id,
    type: raw?.type,
    status: raw?.status,
    isTest: raw?.is_test,
    brandId: raw?.brand_id,
    reference: raw?.reference,
    referenceGenerated: raw?.reference_generated,
    currency: purchase.currency,
    total: purchase.total,
    totalOverride: purchase.total_override,
    refundableAmount: raw?.refundable_amount,
    refundAvailability: raw?.refund_availability,
    checkoutUrl: raw?.checkout_url,
    directPostUrl: raw?.direct_post_url,
    invoiceUrl: raw?.invoice_url,
    clientEmail: raw?.client?.email,
    clientName: raw?.client?.full_name,
    clientPhone: raw?.client?.phone,
    paymentMethod: raw?.transaction_data?.payment_method,
    paymentFlow: raw?.transaction_data?.flow,
    skipCapture: raw?.skip_capture,
    forceRecurring: raw?.force_recurring,
    isRecurringToken: raw?.is_recurring_token,
    recurringToken: raw?.recurring_token,
    createdOn: toIso(raw?.created_on),
    updatedOn: toIso(raw?.updated_on),
    due: toIso(raw?.due) ?? toIso(purchase.due),
    paidOn: toIso(payment.paid_on),
    notes: purchase.notes,
    products,
    statusHistory,
  });
}

/**
 * Reduce the response of a refund, capture, release, or recurring charge.
 *
 * Those endpoints answer either with a `Payment` (the operation completed) or with
 * the `Purchase` itself carrying a `pending_*` status (the operation is still in
 * flight at the acquirer), so the projection reads whichever is present.
 *
 * @param raw - The response body.
 * @returns A compact projection plus `kind`, which says which shape arrived.
 */
export function projectOperation(raw) {
  const payment = raw?.payment;
  const isPurchase = raw?.status !== undefined && raw?.purchase !== undefined;
  if (isPurchase) return { kind: "purchase", purchase: projectPurchase(raw) };
  return {
    kind: "payment",
    payment: compact({
      id: raw?.id,
      type: raw?.type,
      paymentType: payment?.payment_type,
      amount: payment?.amount,
      currency: payment?.currency,
      netAmount: payment?.net_amount,
      feeAmount: payment?.fee_amount,
      description: payment?.description,
      isOutgoing: payment?.is_outgoing,
      paidOn: toIso(payment?.paid_on),
      reference: raw?.reference,
      referenceGenerated: raw?.reference_generated,
      relatedTo: raw?.related_to === undefined ? undefined : `${raw.related_to?.type}/${raw.related_to?.id}`,
      isTest: raw?.is_test,
    }),
  };
}

/**
 * Render a purchase projection as a short report.
 *
 * @param view - Output of {@link projectPurchase}.
 * @returns Markdown text.
 */
export function formatPurchase(view) {
  const lines = [
    `**${view.status ?? "unknown"}** — purchase \`${view.id ?? "?"}\``
      + `${view.isTest === undefined ? "" : view.isTest ? " (test mode)" : " (live mode)"}`,
  ];
  const money = formatMoney(view.total, view.currency);
  if (money !== undefined) lines.push(`Amount: ${money}`);
  if (view.reference !== undefined || view.referenceGenerated !== undefined) {
    lines.push(`Reference: ${view.reference ?? view.referenceGenerated}`);
  }
  if (view.clientEmail !== undefined) lines.push(`Client: ${view.clientName ?? view.clientEmail}${view.clientName === undefined ? "" : ` <${view.clientEmail}>`}`);
  if (view.paymentMethod !== undefined) lines.push(`Payment method: ${view.paymentMethod}`);
  if (view.checkoutUrl !== undefined) lines.push(`Checkout URL: ${view.checkoutUrl}`);
  if (view.invoiceUrl !== undefined) lines.push(`Invoice URL: ${view.invoiceUrl}`);
  if (view.refundAvailability !== undefined) {
    lines.push(`Refund availability: ${view.refundAvailability}`
      + `${view.refundableAmount === undefined ? "" : ` (refundable ${formatMoney(view.refundableAmount, view.currency)})`}`);
  }
  if (view.skipCapture === true) lines.push("skip_capture is on: funds are held until this purchase is captured or released.");
  if (view.isRecurringToken === true) lines.push("A recurring token is saved for this purchase.");
  if (view.due !== undefined) lines.push(`Due: ${view.due}`);
  if (view.paidOn !== undefined) lines.push(`Paid: ${view.paidOn}`);
  if (view.createdOn !== undefined) lines.push(`Created: ${view.createdOn}`);
  if (view.products !== undefined && view.products.length > 0) {
    lines.push("", "Products:");
    for (const product of view.products) {
      lines.push(`- ${product.name ?? "(unnamed)"} — ${formatMoney(product.price, view.currency) ?? "?"}`
        + `${product.quantity === undefined ? "" : ` × ${product.quantity}`}`);
    }
  }
  const history = view.statusHistory;
  if (history !== undefined && history.length > 0) {
    lines.push("", `Status history: ${history.map((entry) => `${entry.status}${entry.at === undefined ? "" : ` @ ${entry.at}`}`).join(" → ")}`);
  }
  return lines.join("\n");
}

/**
 * Render a minor-unit amount as a decimal string.
 *
 * @param amount - Amount in the currency's minor unit (sen for MYR).
 * @param currency - ISO 4217 code.
 * @returns `"MYR 10.00"`, or `undefined` when there is no amount.
 */
export function formatMoney(amount, currency) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  const code = typeof currency === "string" && currency.length > 0 ? currency : "";
  return `${code === "" ? "" : `${code} `}${(amount / 100).toFixed(2)}`.trim();
}

/**
 * Render an operation projection as a short report.
 *
 * @param view - Output of {@link projectOperation}.
 * @returns Markdown text.
 */
export function formatOperation(view) {
  if (view.kind === "purchase") {
    return [
      "CHIP accepted the request; the operation is still completing at the acquirer, so the purchase was returned instead of a payment.",
      "",
      formatPurchase(view.purchase),
    ].join("\n");
  }
  const payment = view.payment;
  return [
    `CHIP recorded a **${payment.paymentType ?? "payment"}** of ${formatMoney(payment.amount, payment.currency) ?? "an unknown amount"}`
      + `${payment.paidOn === undefined ? "" : ` at ${payment.paidOn}`}.`,
    payment.feeAmount === undefined ? "" : `Fee: ${formatMoney(payment.feeAmount, payment.currency)}.`,
    payment.relatedTo === undefined ? "" : `Related to: ${payment.relatedTo}.`,
    `Payment id \`${payment.id ?? "?"}\`.`,
  ].filter((line) => line.length > 0).join("\n");
}

/**
 * Fence a value as pretty-printed JSON for a tool result that stays structured.
 *
 * @param value - Any JSON-serializable value.
 * @returns A fenced JSON block.
 */
export function formatJson(value) {
  return `\`\`\`json\n${JSON.stringify(value, undefined, 2)}\n\`\`\``;
}
