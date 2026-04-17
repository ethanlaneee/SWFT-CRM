// ════════════════════════════════════════════════
// Notification helpers — shared by inbound-message webhooks so
// every channel creates a consistent "new message" notification.
// ════════════════════════════════════════════════

const { db } = require("../firebase");

/**
 * Fire-and-forget notification for an inbound customer message.
 *
 * @param {object} args
 * @param {string} args.orgId      — the owning org id (userId on notifications)
 * @param {string} args.channel    — "sms", "email", "instagram", "facebook", etc.
 * @param {string} args.from       — customer name or identifier (phone, handle…)
 * @param {string} args.body       — message text
 * @param {string|null} [args.customerId]
 */
function notifyInboundMessage({ orgId, channel, from, body, customerId = null }) {
  if (!orgId) return;
  const label = {
    sms: "SMS",
    email: "Email",
    instagram: "Instagram",
    facebook: "Facebook",
    whatsapp: "WhatsApp",
  }[channel] || "Message";
  const preview = (body || "").length > 120 ? body.slice(0, 117) + "…" : (body || "");
  db.collection("notifications").add({
    orgId,
    userId: orgId,
    type: "message",
    channel,
    title: `New ${label} from ${from || "customer"}`,
    body: preview,
    customerId: customerId || null,
    read: false,
    createdAt: Date.now(),
  }).catch(() => {});
}

module.exports = { notifyInboundMessage };
