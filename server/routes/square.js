const router = require("express").Router();
const { db } = require("../firebase");
const { pushNotification } = require("./notifications");

function getSquareClient() {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN is not set");
  return { token, baseUrl: process.env.SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com" };
}

async function squarePost(path, body, token, baseUrl) {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": "2024-01-18",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// POST /api/square/invoice/:id/link
router.post("/invoice/:id/link", async (req, res, next) => {
  try {
    const { token, baseUrl } = getSquareClient();
    const invDoc = await db.collection("invoices").doc(req.params.id).get();
    if (!invDoc.exists || invDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const inv = invDoc.data();

    if (inv.squarePaymentLinkUrl) {
      return res.json({ url: inv.squarePaymentLinkUrl, existing: true });
    }

    const amountCents = Math.round((inv.total || 0) * 100);
    if (amountCents < 100) {
      return res.status(400).json({ error: "Invoice total must be at least $1.00" });
    }

    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) return res.status(500).json({ error: "SQUARE_LOCATION_ID is not set" });

    const idempotencyKey = `inv-${req.params.id}-${Date.now()}`;
    const data = await squarePost("/v2/online-checkout/payment-links", {
      idempotency_key: idempotencyKey,
      quick_pay: {
        name: `Invoice — ${inv.customerName || "Customer"}${inv.service ? ` (${inv.service})` : ""}`,
        price_money: { amount: amountCents, currency: "USD" },
        location_id: locationId,
      },
      checkout_options: {
        redirect_url: `${process.env.APP_URL || "https://goswft.com"}/swft-invoices`,
      },
      pre_populated_data: {
        buyer_email: inv.customerEmail || undefined,
      },
    }, token, baseUrl);

    if (data.errors) {
      console.error("Square error:", data.errors);
      return res.status(400).json({ error: data.errors[0]?.detail || "Square error" });
    }

    const url = data.payment_link?.url;
    const linkId = data.payment_link?.id;

    await db.collection("invoices").doc(req.params.id).update({
      squarePaymentLinkUrl: url,
      squarePaymentLinkId: linkId,
      updatedAt: Date.now(),
    });

    res.json({ url });
  } catch (err) { next(err); }
});

// POST /api/square/webhook — Square sends payment.completed events
async function squareWebhookHandler(req, res) {
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (event.type !== "payment.updated") return res.json({ received: true });

    const payment = event.data?.object?.payment;
    if (!payment || payment.status !== "COMPLETED") return res.json({ received: true });

    // Find invoice by squarePaymentLinkId
    const invoiceRef = payment.order_id
      ? await db.collection("invoices").where("squareOrderId", "==", payment.order_id).limit(1).get()
      : null;

    if (invoiceRef && !invoiceRef.empty) {
      const invDoc = invoiceRef.docs[0];
      const inv = invDoc.data();
      if (inv.status !== "paid") {
        await invDoc.ref.update({
          status: "paid",
          paidAt: Date.now(),
          paymentMethod: "square",
          squarePaymentId: payment.id,
          updatedAt: Date.now(),
        });
        await pushNotification(inv.userId || inv.orgId, {
          type: "payment",
          title: "Payment Received (Square)",
          body: `${inv.customerName} paid invoice — $${inv.total}`,
          link: "/swft-invoices",
        });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Square webhook error:", err);
    res.json({ received: true });
  }
}

module.exports = { router, squareWebhookHandler };
