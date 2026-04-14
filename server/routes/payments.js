const router = require("express").Router();
const { db } = require("../firebase");
const { pushNotification } = require("./notifications");
const { getStripe } = require("../utils/stripe");
const { triggerAutomation } = require("./automations");

// POST /api/payments/invoice/:id/link
// Creates (or retrieves) a Stripe Payment Link for an invoice
router.post("/invoice/:id/link", async (req, res, next) => {
  try {
    const stripe = getStripe();
    const invDoc = await db.collection("invoices").doc(req.params.id).get();
    if (!invDoc.exists || invDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const inv = invDoc.data();

    // Return existing link if already created
    if (inv.paymentLinkUrl) {
      return res.json({ url: inv.paymentLinkUrl, existing: true });
    }

    const amountCents = Math.round((inv.total || 0) * 100);
    if (amountCents < 50) {
      return res.status(400).json({ error: "Invoice total must be at least $0.50 to create a payment link" });
    }

    // Create a one-time price
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: amountCents,
      product_data: {
        name: `Invoice — ${inv.customerName || "Customer"}${inv.service ? ` (${inv.service})` : ""}`,
      },
    });

    // Create Payment Link with invoice metadata so webhook can match it
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: {
        invoiceId: req.params.id,
        orgId: req.orgId,
      },
      after_completion: {
        type: "hosted_confirmation",
        hosted_confirmation: { custom_message: "Payment received. Thank you!" },
      },
    });

    // Store on invoice
    await db.collection("invoices").doc(req.params.id).update({
      paymentLinkUrl: paymentLink.url,
      stripePaymentLinkId: paymentLink.id,
      updatedAt: Date.now(),
    });

    res.json({ url: paymentLink.url });
  } catch (err) { next(err); }
});

// POST /api/payments/webhook — Stripe webhook (raw body, registered in index.js)
// Auto-marks invoice paid when checkout completes via payment link
async function webhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const invoiceId = session.metadata?.invoiceId;
    if (invoiceId) {
      try {
        const invDoc = await db.collection("invoices").doc(invoiceId).get();
        const inv = invDoc.exists ? invDoc.data() : {};
        await db.collection("invoices").doc(invoiceId).update({
          status: "paid",
          paidAt: Date.now(),
          paymentMethod: "stripe",
          stripeSessionId: session.id,
          updatedAt: Date.now(),
        });
        console.log(`Invoice ${invoiceId} auto-marked paid via Stripe`);

        const orgId = inv.orgId || session.metadata?.orgId;

        // Notify the org owner
        if (inv.userId) {
          await pushNotification(inv.userId, {
            type: "payment",
            title: "Payment Received",
            body: `${inv.customerName || "A customer"} paid invoice #${invoiceId.slice(-4)} — $${(inv.total || 0).toLocaleString()}`,
            link: "/swft-invoices",
          });
        }

        // Build customer object for automations
        if (orgId && inv.customerId) {
          try {
            const custDoc = await db.collection("customers").doc(inv.customerId).get();
            const cust = custDoc.exists ? custDoc.data() : {};
            const customer = {
              id: inv.customerId,
              name: cust.name || inv.customerName || "",
              phone: cust.phone || "",
              email: cust.email || "",
              total: inv.total || 0,
              service: inv.service || "",
            };

            // 1. Fire invoice_paid automation
            triggerAutomation(orgId, "invoice_paid", customer).catch(console.error);

            // 2. Find and complete related active/scheduled jobs
            let jobQuery = db.collection("jobs")
              .where("orgId", "==", orgId)
              .where("customerId", "==", inv.customerId);
            const jobsSnap = await jobQuery.get();

            const jobsToComplete = jobsSnap.docs.filter(d => {
              const data = d.data();
              // Exclude already-completed or cancelled jobs
              if (data.status === "complete" || data.status === "cancelled") return false;
              // If invoice has a quoteId, prefer jobs that match it; otherwise include all active jobs
              if (inv.quoteId && data.quoteId && data.quoteId !== inv.quoteId) return false;
              return true;
            });

            for (const jobDoc of jobsToComplete) {
              const jobData = jobDoc.data();
              await jobDoc.ref.update({ status: "complete", completedAt: Date.now(), updatedAt: Date.now() });
              console.log(`Job ${jobDoc.id} auto-completed via Stripe payment for invoice ${invoiceId}`);

              // 3. Fire job_completed automation for each completed job
              const jobCustomer = {
                ...customer,
                total: jobData.cost || customer.total,
                service: jobData.service || customer.service,
              };
              triggerAutomation(orgId, "job_completed", jobCustomer).catch(console.error);
            }
          } catch (autoErr) {
            console.error("Stripe webhook automation/job error:", autoErr);
          }
        }
      } catch (err) {
        console.error(`Failed to mark invoice ${invoiceId} as paid:`, err);
      }
    }
  }

  res.json({ received: true });
}

module.exports = { router, webhookHandler };
