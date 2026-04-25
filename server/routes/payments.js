const router = require("express").Router();
const { db } = require("../firebase");
const { pushNotification } = require("./notifications");
const { getStripe } = require("../utils/stripe");
const { triggerAutomation } = require("./automations");

// POST /api/payments/invoice/:id/link
// Creates (or retrieves) a Stripe Payment Link for an invoice on the
// owner's connected Stripe account. Returns 400 with a "notConnected"
// flag if the owner hasn't linked Stripe yet — the UI uses that to prompt
// them to go connect.
router.post("/invoice/:id/link", async (req, res, next) => {
  try {
    const stripe = getStripe();
    const invDoc = await db.collection("invoices").doc(req.params.id).get();
    if (!invDoc.exists || invDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const inv = invDoc.data();

    // Look up the org owner's Stripe Connect account
    const ownerDoc = await db.collection("users").doc(req.orgId).get();
    const ownerStripe = ownerDoc.exists ? ownerDoc.data()?.integrations?.stripe : null;
    const connectedAccountId = ownerStripe?.accountId;
    if (!connectedAccountId) {
      return res.status(400).json({
        error: "Connect your Stripe account first to accept payments on invoices.",
        notConnected: true,
      });
    }

    // Return existing link if it was already created on this same account
    if (inv.paymentLinkUrl && inv.stripeConnectAccountId === connectedAccountId) {
      return res.json({ url: inv.paymentLinkUrl, existing: true });
    }

    const amountCents = Math.round((inv.total || 0) * 100);
    if (amountCents < 50) {
      return res.status(400).json({ error: "Invoice total must be at least $0.50 to create a payment link" });
    }

    // Everything below runs on the connected account, so the money lands
    // in the owner's Stripe balance — not ours.
    const stripeOpts = { stripeAccount: connectedAccountId };

    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: amountCents,
      product_data: {
        name: `Invoice — ${inv.customerName || "Customer"}${inv.service ? ` (${inv.service})` : ""}`,
      },
    }, stripeOpts);

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
    }, stripeOpts);

    await db.collection("invoices").doc(req.params.id).update({
      paymentLinkUrl: paymentLink.url,
      stripePaymentLinkId: paymentLink.id,
      stripeConnectAccountId: connectedAccountId,
      updatedAt: Date.now(),
    });

    res.json({ url: paymentLink.url });
  } catch (err) { next(err); }
});

// POST /api/payments/webhook — Stripe webhook (raw body, registered in index.js)
// Auto-marks invoice paid when checkout completes via payment link
async function webhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  // Connect events from connected accounts are signed with their own webhook
  // secret (separate destination in Stripe dashboard). Fall back to the
  // platform secret so local dev / single-webhook setups still work.
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Recurring invoices: Stripe generates + collects each cycle on the owner's
  // connected account. We mirror the outcome onto the parent SWFT invoice so
  // the owner can see paid cycles, outstanding cycles, and failures.
  if (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
    const stripeInvoice = event.data.object;
    const subscriptionId = stripeInvoice.subscription;
    if (subscriptionId) {
      try {
        const parentSnap = await db.collection("invoices")
          .where("stripeSubscriptionId", "==", subscriptionId)
          .limit(1)
          .get();
        if (!parentSnap.empty) {
          const parentDoc = parentSnap.docs[0];
          const parent = parentDoc.data();

          // Connect-account safety check — same pattern as below
          if (event.account && parent.stripeConnectAccountId && event.account !== parent.stripeConnectAccountId) {
            console.warn(`[stripe-webhook] subscription account mismatch, ignoring`);
            return res.json({ received: true, ignored: "account_mismatch" });
          }

          const paid = event.type === "invoice.payment_succeeded";
          const update = { updatedAt: Date.now() };

          if (paid) {
            update["recurring.completedCycles"] = (parent.recurring?.completedCycles || 0) + 1;
            update["recurring.lastPaidAt"] = Date.now();
            update["recurring.lastPaidAmount"] = (stripeInvoice.amount_paid || 0) / 100;
            update["recurring.lastError"] = null;

            // Check cycle cap — if the user said "bill me 6 times" and we've hit 6, cancel.
            const cap = parent.recurring?.cycleCount;
            if (cap && update["recurring.completedCycles"] >= cap) {
              try {
                await getStripe().subscriptions.cancel(subscriptionId, {
                  stripeAccount: parent.stripeConnectAccountId,
                });
                update["recurring.status"] = "completed";
                update["recurring.cancelledAt"] = Date.now();
              } catch (e) {
                console.warn("[stripe-webhook] auto-cancel after cycle cap failed:", e.message);
              }
            }
          } else {
            update["recurring.lastError"] = stripeInvoice.last_finalization_error?.message
              || "Payment failed";
            update["recurring.lastFailedAt"] = Date.now();
          }

          await parentDoc.ref.update(update);

          // Log a per-cycle record so the owner can see history. Separate
          // subcollection keeps the main invoices list clean.
          await parentDoc.ref.collection("cycles").add({
            stripeInvoiceId: stripeInvoice.id,
            stripeInvoiceNumber: stripeInvoice.number || null,
            hostedInvoiceUrl: stripeInvoice.hosted_invoice_url || null,
            amount: (stripeInvoice.amount_paid || stripeInvoice.amount_due || 0) / 100,
            status: paid ? "paid" : "failed",
            periodStart: stripeInvoice.period_start ? stripeInvoice.period_start * 1000 : null,
            periodEnd: stripeInvoice.period_end ? stripeInvoice.period_end * 1000 : null,
            createdAt: Date.now(),
          });

          // Notify + fire automation on paid cycles
          if (paid && parent.userId) {
            await pushNotification(parent.userId, {
              type: "payment",
              title: "Recurring Payment Received",
              body: `${parent.customerName || "A customer"} paid cycle #${update["recurring.completedCycles"]} — $${((stripeInvoice.amount_paid || 0) / 100).toLocaleString()}`,
              link: "/swft-invoices",
            });
          }

          if (paid && parent.customerId && parent.orgId) {
            try {
              const custDoc = await db.collection("customers").doc(parent.customerId).get();
              const cust = custDoc.exists ? custDoc.data() : {};
              triggerAutomation(parent.orgId, "invoice_paid", {
                id: parent.customerId,
                invoiceId: parentDoc.id,
                name: cust.name || parent.customerName || "",
                phone: cust.phone || "",
                email: cust.email || "",
                total: (stripeInvoice.amount_paid || 0) / 100,
                service: parent.service || "",
              }).catch(console.error);
            } catch (autoErr) {
              console.error("Recurring payment automation error:", autoErr);
            }
          }
        }
      } catch (err) {
        console.error(`[stripe-webhook] subscription invoice handling failed:`, err);
      }
    }
  }

  // Stripe marks a Subscription as "canceled" either when we cancel it, when
  // cancel_at is reached, or when retries exhaust on payment failure. Keep
  // the parent doc in sync either way.
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    try {
      const parentSnap = await db.collection("invoices")
        .where("stripeSubscriptionId", "==", sub.id)
        .limit(1)
        .get();
      if (!parentSnap.empty) {
        const parentDoc = parentSnap.docs[0];
        const parent = parentDoc.data();
        if (event.account && parent.stripeConnectAccountId && event.account !== parent.stripeConnectAccountId) {
          return res.json({ received: true, ignored: "account_mismatch" });
        }
        if (parent.recurring?.status !== "completed" && parent.recurring?.status !== "cancelled") {
          await parentDoc.ref.update({
            "recurring.status": "cancelled",
            "recurring.cancelledAt": Date.now(),
            updatedAt: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error("[stripe-webhook] subscription.deleted handling failed:", err);
    }
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const invoiceId = session.metadata?.invoiceId;
    if (invoiceId) {
      try {
        const invDoc = await db.collection("invoices").doc(invoiceId).get();
        const inv = invDoc.exists ? invDoc.data() : {};

        // Connect safety check: if the event came from a connected account
        // (event.account is set), it must match the account this invoice's
        // pay link was created on. Prevents any other Stripe account from
        // spoofing a paid event for someone else's invoice.
        if (event.account && inv.stripeConnectAccountId && event.account !== inv.stripeConnectAccountId) {
          console.warn(`[stripe-webhook] account mismatch for invoice ${invoiceId}: event.account=${event.account} inv=${inv.stripeConnectAccountId}`);
          return res.json({ received: true, ignored: "account_mismatch" });
        }

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
