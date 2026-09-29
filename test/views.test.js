/**
 * Unit tests for response projection and text formatting.
 *
 * The purchase fixture mirrors the example in the CHIP Collect OpenAPI document, so
 * these tests fail if a projection drifts from the vendor's actual field names.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  compact,
  formatJson,
  formatMoney,
  formatOperation,
  formatPurchase,
  projectOperation,
  projectPurchase,
  toIso,
} from "../lib/views.js";

/** A paid purchase, shaped like the spec's `Purchase` example. */
const PAID_PURCHASE = {
  id: "00000000-0000-0000-0000-000000000001",
  type: "purchase",
  status: "paid",
  is_test: true,
  brand_id: "00000000-0000-0000-0000-000000000003",
  reference: "INV-1001",
  reference_generated: "CH0001",
  due: 1_735_689_600,
  created_on: 1_735_603_200,
  updated_on: 1_735_700_000,
  is_recurring_token: true,
  recurring_token: "tok_secret_value",
  skip_capture: false,
  refund_availability: "all",
  refundable_amount: 1_000,
  checkout_url: "https://gate.chip-in.asia/p/00000000-0000-0000-0000-000000000001/",
  invoice_url: null,
  direct_post_url: null,
  status_history: [
    { status: "created", timestamp: 1_735_603_200 },
    { status: "paid", timestamp: 1_735_700_000 },
  ],
  client: { email: "buyer@example.com", full_name: "Test Buyer", phone: "" },
  purchase: {
    currency: "MYR",
    notes: "",
    total: 1_000,
    total_override: null,
    products: [{ name: "Premium Subscription", price: 1_000, quantity: "1.0000" }],
  },
  payment: { paid_on: 1_735_700_000, payment_type: "purchase" },
  transaction_data: { payment_method: "fpx", flow: "payform" },
};

test("compact drops nullish entries and keeps falsy ones", () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: null, d: 0, e: false, f: "" }), { a: 1, d: 0, e: false, f: "" });
});

test("toIso converts unix seconds, passes ISO strings through, and gives up on junk", () => {
  assert.equal(toIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(toIso(1_735_603_200), "2024-12-31T00:00:00.000Z");
  assert.equal(toIso("2024-12-31"), "2024-12-31");
  assert.equal(toIso(undefined), undefined);
  assert.equal(toIso(null), undefined);
  assert.equal(toIso(""), undefined);
  assert.equal(toIso(Number.NaN), undefined);
});

test("projectPurchase reads the vendor's field names and drops the absent ones", () => {
  const view = projectPurchase(PAID_PURCHASE);
  assert.equal(view.id, PAID_PURCHASE.id);
  assert.equal(view.status, "paid");
  assert.equal(view.isTest, true);
  assert.equal(view.brandId, PAID_PURCHASE.brand_id);
  assert.equal(view.reference, "INV-1001");
  assert.equal(view.currency, "MYR");
  assert.equal(view.total, 1_000);
  assert.equal(view.refundableAmount, 1_000);
  assert.equal(view.refundAvailability, "all");
  assert.equal(view.clientEmail, "buyer@example.com");
  assert.equal(view.clientName, "Test Buyer");
  assert.equal(view.paymentMethod, "fpx");
  assert.equal(view.paymentFlow, "payform");
  assert.equal(view.isRecurringToken, true);
  assert.equal(view.recurringToken, "tok_secret_value");
  assert.equal(view.createdOn, "2024-12-31T00:00:00.000Z");
  assert.equal(view.due, "2025-01-01T00:00:00.000Z");
  assert.equal(view.paidOn, "2025-01-01T02:53:20.000Z");
  assert.deepEqual(view.products, [{ name: "Premium Subscription", price: 1_000, quantity: "1.0000" }]);
  assert.deepEqual(view.statusHistory, [
    { status: "created", at: "2024-12-31T00:00:00.000Z" },
    { status: "paid", at: "2025-01-01T02:53:20.000Z" },
  ]);
  assert.equal("invoiceUrl" in view, false, "a null invoice_url must be absent, not empty");
  assert.equal("totalOverride" in view, false);
  assert.equal(view.notes, "", "compact keeps an empty string, because only nullish values are dropped");
});

test("projectPurchase tolerates an empty response", () => {
  assert.deepEqual(projectPurchase(undefined), {});
  assert.deepEqual(projectPurchase({}), {});
});

test("formatMoney renders minor units as a decimal amount", () => {
  assert.equal(formatMoney(1_000, "MYR"), "MYR 10.00");
  assert.equal(formatMoney(1, "MYR"), "MYR 0.01");
  assert.equal(formatMoney(0, "MYR"), "MYR 0.00");
  assert.equal(formatMoney(1_000, undefined), "10.00");
  assert.equal(formatMoney(undefined, "MYR"), undefined);
  assert.equal(formatMoney("1000", "MYR"), undefined, "a string is not an amount");
});

test("formatPurchase surfaces the facts a decision needs", () => {
  const text = formatPurchase(projectPurchase(PAID_PURCHASE));
  assert.match(text, /\*\*paid\*\*/u);
  assert.match(text, /\(test mode\)/u);
  assert.match(text, /Amount: MYR 10\.00/u);
  assert.match(text, /Reference: INV-1001/u);
  assert.match(text, /Client: Test Buyer <buyer@example\.com>/u);
  assert.match(text, /Checkout URL: https:\/\/gate\.chip-in\.asia/u);
  assert.match(text, /Refund availability: all \(refundable MYR 10\.00\)/u);
  assert.match(text, /A recurring token is saved/u);
  assert.match(text, /Premium Subscription — MYR 10\.00 × 1\.0000/u);
  assert.match(text, /created @ .* → paid @ .*/u);
});

test("formatPurchase warns that funds are held when skip_capture is on", () => {
  const held = projectPurchase({ ...PAID_PURCHASE, skip_capture: true, status: "hold" });
  assert.match(formatPurchase(held), /funds are held until this purchase is captured or released/u);
});

test("projectOperation distinguishes a completed payment from an in-flight purchase", () => {
  const payment = projectOperation({
    id: "pay-1",
    type: "payment",
    is_test: true,
    reference: "INV-1001",
    reference_generated: "CH0001",
    related_to: { type: "purchase", id: "p1" },
    payment: {
      payment_type: "refund",
      amount: 500,
      currency: "MYR",
      net_amount: 500,
      fee_amount: 0,
      is_outgoing: true,
      paid_on: 1_735_700_000,
    },
  });
  assert.equal(payment.kind, "payment");
  assert.equal(payment.payment.amount, 500);
  assert.equal(payment.payment.relatedTo, "purchase/p1");
  assert.equal(payment.payment.paidOn, "2025-01-01T02:53:20.000Z");

  const inFlight = projectOperation({ ...PAID_PURCHASE, status: "pending_refund" });
  assert.equal(inFlight.kind, "purchase");
  assert.equal(inFlight.purchase.status, "pending_refund");
});

test("formatOperation explains which shape came back", () => {
  const paymentText = formatOperation(projectOperation({
    id: "pay-1",
    type: "payment",
    payment: { payment_type: "refund", amount: 500, currency: "MYR", paid_on: 1_735_700_000 },
  }));
  assert.match(paymentText, /\*\*refund\*\* of MYR 5\.00/u);
  assert.match(paymentText, /Payment id `pay-1`/u);

  const purchaseText = formatOperation(projectOperation({ ...PAID_PURCHASE, status: "pending_refund" }));
  assert.match(purchaseText, /still completing at the acquirer/u);
  assert.match(purchaseText, /\*\*pending_refund\*\*/u);
});

test("formatJson fences pretty-printed JSON", () => {
  assert.equal(formatJson({ a: 1 }), "```json\n{\n  \"a\": 1\n}\n```");
});
