const router = require("express").Router();
const { db } = require("../firebase");
const { pushNotification } = require("./notifications");
const { getStripe, ensureStripeCustomer } = require("../utils/stripe");
const { triggerAutomation } = require("./automations");

// Helper: build the public pay-redirect URL for a quote or invoice.
// The redirect creates a fresh Stripe Checkout Session at click-time
// attached to the pre-existing Stripe Customer, so customer attribution
// works in the owner's Stripe dashboard even though paymentLinks.create()
// can't accept a customer:.
function payRedirectUrl(kind, id) {
  const base = process.env.APP_URL || "https://goswft.com";
  return `${base}/api/pay/${kind}/${id}`;
}

// Returns the persistent pay-redirect URL for an invoice. Requires the
// owner has Stripe Connect set up (so the redirect can build a session).
router.post("/invoice/:id/link", async (req, res, next) => {
  try {
    const invDoc = await db.collection("invoices").doc(req.params.id).get();
    if (!invDoc.exists || invDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    const inv = invDoc.data();

    const ownerDoc = await db.collection("users").doc(req.orgId).get();
    const connectedAccountId = ownerDoc.exists ? ownerDoc.data()?.integrations?.stripe?.accountId : null;
    if (!connectedAccountId) {
      return res.status(400).json({
        error: "Connect your Stripe account first to accept payments on invoices.",
        notConnected: true,
      });
    }
    if (Math.round((inv.total || 0) * 100) < 50) {
      return res.status(400).json({ error: "Invoice total must be at least $0.50 to create a payment link" });
    }

    res.json({ url: payRedirectUrl("invoice", req.params.id) });
  } catch (err) { next(err); }
});

// Returns the persistent pay-redirect URL for a quote. Requires the
// owner has Stripe Connect set up.
router.post("/quote/:id/link", async (req, res, next) => {
  try {
    const qDoc = await db.collection("quotes").doc(req.params.id).get();
    if (!qDoc.exists || qDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Quote not found" });
    }
    const q = qDoc.data();

    const ownerDoc = await db.collection("users").doc(req.orgId).get();
    const connectedAccountId = ownerDoc.exists ? ownerDoc.data()?.integrations?.stripe?.accountId : null;
    if (!connectedAccountId) {
      return res.status(400).json({
        error: "Connect your Stripe account first to accept payments on quotes.",
        notConnected: true,
      });
    }
    if (Math.round((q.total || 0) * 100) < 50) {
      return res.status(400).json({ error: "Quote total must be at least $0.50 to create a payment link" });
    }

    res.json({ url: payRedirectUrl("quote", req.params.id) });
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

    // Quote paid → mark quote, mirror as a paid invoice so the financial
    // record lives in the invoices collection (and the customer's payment
    // history). Runs first so a payment link that somehow has both IDs
    // is treated as a quote payment, not duplicated.
    const quoteId = session.metadata?.quoteId;
    if (quoteId && !session.metadata?.invoiceId) {
      try {
        const qDoc = await db.collection("quotes").doc(quoteId).get();
        const q = qDoc.exists ? qDoc.data() : {};

        if (event.account && q.stripeConnectAccountId && event.account !== q.stripeConnectAccountId) {
          console.warn(`[stripe-webhook] account mismatch for quote ${quoteId}`);
          return res.json({ received: true, ignored: "account_mismatch" });
        }

        await db.collection("quotes").doc(quoteId).update({
          status: "paid",
          paidAt: Date.now(),
          paymentMethod: "stripe",
          stripeSessionId: session.id,
          updatedAt: Date.now(),
        });

        // Mirror as a paid invoice. If the quote was already converted to
        // an invoice manually, mark THAT one paid instead of duplicating.
        const orgIdForLookup = q.orgId || session.metadata?.orgId || null;
        let invRefId = null;
        if (orgIdForLookup) {
          const existingSnap = await db.collection("invoices")
            .where("orgId", "==", orgIdForLookup)
            .where("quoteId", "==", quoteId)
            .limit(1).get();
          if (!existingSnap.empty) {
            const existing = existingSnap.docs[0];
            await existing.ref.update({
              status: "paid",
              paidAt: Date.now(),
              paymentMethod: "stripe",
              stripeSessionId: session.id,
              stripeConnectAccountId: q.stripeConnectAccountId || null,
              updatedAt: Date.now(),
            });
            invRefId = existing.id;
            console.log(`Quote ${quoteId} paid; marked existing invoice ${invRefId} paid`);
          }
        }
        if (!invRefId) {
          const newInvoiceData = {
            orgId: orgIdForLookup,
            userId: q.userId || null,
            customerId: q.customerId || null,
            customerName: q.customerName || "",
            quoteId,
            items: q.items || [],
            subtotal: q.subtotal || q.total || 0,
            taxRate: q.taxRate || 0,
            tax: q.tax || 0,
            total: q.total || 0,
            service: q.service || "",
            sqft: q.sqft || "",
            address: q.address || "",
            finish: q.finish || "",
            notes: q.notes || "",
            status: "paid",
            paidAt: Date.now(),
            paymentMethod: "stripe",
            stripeSessionId: session.id,
            stripeConnectAccountId: q.stripeConnectAccountId || null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const invRef = await db.collection("invoices").add(newInvoiceData);
          invRefId = invRef.id;
          console.log(`Quote ${quoteId} paid; auto-created paid invoice ${invRefId}`);
        }

        if (q.userId) {
          await pushNotification(q.userId, {
            type: "payment",
            title: "Quote Paid",
            body: `${q.customerName || "A customer"} paid quote #${quoteId.slice(-4)} — $${(q.total || 0).toLocaleString()}`,
            link: "/swft-invoices",
          });
        }

        const orgId = q.orgId || session.metadata?.orgId;
        if (orgId && q.customerId) {
          try {
            const custDoc = await db.collection("customers").doc(q.customerId).get();
            const cust = custDoc.exists ? custDoc.data() : {};
            const customer = {
              id: q.customerId,
              name: cust.name || q.customerName || "",
              phone: cust.phone || "",
              email: cust.email || "",
              total: q.total || 0,
              service: q.service || "",
            };
            triggerAutomation(orgId, "quote_paid", customer).catch(console.error);
            triggerAutomation(orgId, "invoice_paid", customer).catch(console.error);
          } catch (autoErr) {
            console.error("Quote-paid automation error:", autoErr);
          }
        }
      } catch (err) {
        console.error(`Failed to mark quote ${quoteId} as paid:`, err);
      }
    }

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
