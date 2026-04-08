/**
 * SWFT — Meta Graph API Client
 *
 * Handles Facebook Messenger and Instagram Direct Messages.
 * One Facebook App covers both channels via the same Page connection.
 *
 * Required env vars:
 *   META_APP_ID            — From developers.facebook.com
 *   META_APP_SECRET        — From developers.facebook.com
 *   META_WEBHOOK_VERIFY_TOKEN — Any random string you set when configuring the webhook
 *   APP_URL                — e.g. https://goswft.com (used for OAuth redirect URI)
 */

const GRAPH = "https://graph.facebook.com/v19.0";

function cfg() {
  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "swft_meta_webhook",
    appUrl: process.env.APP_URL || "https://goswft.com",
  };
}

function isConfigured() {
  const { appId, appSecret } = cfg();
  return !!(appId && appSecret);
}

/**
 * Build the Facebook OAuth URL.
 * @param {string} state - Opaque state string (base64 JSON with uid)
 */
function getOAuthUrl(state) {
  const { appId, appUrl } = cfg();
  const redirectUri = encodeURIComponent(`${appUrl}/api/meta/callback`);
  const scope = [
    "pages_messaging",
    "pages_read_engagement",
    "pages_manage_metadata",
    "instagram_manage_messages",
    "instagram_basic",
  ].join(",");
  return `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&state=${encodeURIComponent(state)}&response_type=code`;
}

/**
 * Exchange a short-lived code for a user access token.
 */
async function exchangeCodeForToken(code) {
  const { appId, appSecret, appUrl } = cfg();
  const redirectUri = encodeURIComponent(`${appUrl}/api/meta/callback`);
  const url = `${GRAPH}/oauth/access_token?client_id=${appId}&redirect_uri=${redirectUri}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.access_token; // short-lived user token
}

/**
 * Exchange a short-lived user token for a long-lived one (60 days).
 */
async function getLongLivedToken(shortToken) {
  const { appId, appSecret } = cfg();
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.access_token;
}

/**
 * Fetch the Facebook Pages the user manages.
 * Returns array of { id, name, access_token, instagram_business_account? }
 */
async function getUserPages(userAccessToken) {
  const url = `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userAccessToken}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.data || [];
}

/**
 * Subscribe a Page to the SWFT webhook so we receive message events.
 */
async function subscribePageWebhook(pageId, pageAccessToken) {
  const url = `${GRAPH}/${pageId}/subscribed_apps`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      subscribed_fields: "messages,messaging_postbacks,messaging_referrals",
      access_token: pageAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.success === true;
}

/**
 * Unsubscribe a Page from the SWFT webhook.
 */
async function unsubscribePageWebhook(pageId, pageAccessToken) {
  const url = `${GRAPH}/${pageId}/subscribed_apps`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: pageAccessToken }),
  });
  const data = await res.json();
  return data.success === true;
}

/**
 * Send a Facebook Messenger reply.
 * @param {string} pageAccessToken - Page access token
 * @param {string} recipientPsid - Sender's page-scoped user ID
 * @param {string} text - Message text
 */
async function sendFacebookMessage(pageAccessToken, recipientPsid, text) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${pageAccessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientPsid },
      message: { text },
      messaging_type: "RESPONSE",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { messageId: data.message_id };
}

/**
 * Send an Instagram DM reply.
 * @param {string} pageAccessToken - Page access token (same one as FB)
 * @param {string} igUserId - Your Instagram user ID (from the Page's IG account)
 * @param {string} recipientIgId - The IG-scoped ID of the person who messaged you
 * @param {string} text - Message text
 */
async function sendInstagramMessage(pageAccessToken, igUserId, recipientIgId, text) {
  const res = await fetch(`${GRAPH}/${igUserId}/messages?access_token=${pageAccessToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientIgId },
      message: { text },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return { messageId: data.message_id };
}

/**
 * Look up the display name of a Facebook user (for naming unknown threads).
 */
async function getFacebookUserName(psid, pageAccessToken) {
  try {
    const res = await fetch(`${GRAPH}/${psid}?fields=name&access_token=${pageAccessToken}`);
    const data = await res.json();
    return data.name || null;
  } catch {
    return null;
  }
}

/**
 * Look up the display name of an Instagram user.
 */
async function getInstagramUserName(igScopedId, pageAccessToken) {
  try {
    const res = await fetch(`${GRAPH}/${igScopedId}?fields=name,username&access_token=${pageAccessToken}`);
    const data = await res.json();
    return data.name || data.username || null;
  } catch {
    return null;
  }
}

module.exports = {
  isConfigured,
  getOAuthUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  getUserPages,
  subscribePageWebhook,
  unsubscribePageWebhook,
  sendFacebookMessage,
  sendInstagramMessage,
  getFacebookUserName,
  getInstagramUserName,
  cfg,
};
