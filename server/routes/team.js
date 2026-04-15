// ════════════════════════════════════════════════
// Team Routes — multi-user team management
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");
const crypto = require("crypto");
const { sendSimpleGmail } = require("../utils/email");

// Accounts whose role can never be changed by any team operation
const PROTECTED_EMAILS = ["ethan@goswft.com"];

// Plan-based team gating helper (Pro+ only)
async function requireTeamPlan(req, res) {
  const userDoc = await db.collection("users").doc(req.uid).get();
  const plan = userDoc.exists ? (userDoc.data().plan || "starter") : "starter";
  if (plan === "starter") {
    res.status(403).json({
      error: "Team management requires the Pro plan or higher.",
      limitReached: true,
      type: "team",
      currentPlan: "starter",
      upgradeTo: "pro",
    });
    return false;
  }
  return true;
}

const ROLES = ["owner", "admin", "technician", "office"];

// ── Gmail helper for sending invite emails ──

async function sendInviteViaGmail(ownerUser, toEmail, inviteUrl, orgName, role, companyLogo) {
  const subject = `You're invited to join ${orgName} on SWFT`;

  const logoHtml = companyLogo
    ? `<img src="${companyLogo}" alt="${orgName}" style="max-height:48px;max-width:180px;margin-bottom:8px;" />`
    : "";

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#0a0a0a;padding:32px 40px;text-align:center;">
      ${logoHtml}
      <h1 style="margin:0;font-size:22px;font-weight:700;color:#c8f135;letter-spacing:0.5px;">${orgName}</h1>
    </div>

    <!-- Body -->
    <div style="padding:36px 40px;">
      <h2 style="margin:0 0 12px;font-size:20px;font-weight:600;color:#1a1a1a;">You've been invited!</h2>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#444;">
        <strong>${orgName}</strong> has invited you to join their team on <strong>SWFT</strong> as a <strong style="text-transform:capitalize;">${role}</strong>.
      </p>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#444;">
        SWFT helps service businesses manage jobs, customers, scheduling, and more — all in one place. Click below to accept and get started.
      </p>

      <!-- CTA Button -->
      <div style="text-align:center;margin:0 0 28px;">
        <a href="${inviteUrl}" style="display:inline-block;background:#c8f135;color:#0a0a0a;text-decoration:none;font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;letter-spacing:0.3px;">Accept Invite</a>
      </div>

      <p style="margin:0 0 8px;font-size:13px;color:#888;line-height:1.5;">
        This invite expires in 7 days. If you weren't expecting this, you can safely ignore this email.
      </p>
      <p style="margin:0;font-size:12px;color:#aaa;word-break:break-all;">
        ${inviteUrl}
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 40px;background:#fafafa;border-top:1px solid #eee;text-align:center;">
      <p style="margin:0;font-size:12px;color:#999;">Sent via <strong>SWFT</strong> &mdash; goswft.com</p>
    </div>

  </div>
</body>
</html>`;

  const textBody = `You're invited to join ${orgName} on SWFT!\n\n${orgName} has invited you to join their team as a ${role}.\n\nAccept your invite: ${inviteUrl}\n\nThis invite expires in 7 days.\n\nSent via SWFT — goswft.com`;

  ownerUser.company = orgName;
  await sendSimpleGmail(ownerUser, toEmail, subject, textBody, htmlBody);
}

// ── Role permission helpers ──

function canManageTeam(role) {
  return ["owner", "admin"].includes(role);
}

function canChangeRole(actorRole, targetRole) {
  // Only owners can promote to admin; admins can manage technician/office
  if (actorRole === "owner") return true;
  if (actorRole === "admin" && targetRole !== "owner") return true;
  return false;
}

// GET /api/team — list all team members in the org
router.get("/", async (req, res, next) => {
  try {
    const snap = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .get();

    const members = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        uid: data.uid || null,
        name: data.name || "",
        email: data.email || "",
        role: data.role || "technician",
        status: data.status || "active",
        joinedAt: data.joinedAt || null,
        invitedAt: data.invitedAt || null,
        avatarInitials: (data.name || data.email || "?")[0].toUpperCase(),
      };
    });

    // Sort: owner first, then by name
    const roleOrder = { owner: 0, admin: 1, office: 2, technician: 3 };
    members.sort((a, b) =>
      (roleOrder[a.role] ?? 4) - (roleOrder[b.role] ?? 4) ||
      a.name.localeCompare(b.name)
    );

    res.json({ members });
  } catch (err) { next(err); }
});

// POST /api/team/invite — invite a new team member
router.post("/invite", async (req, res, next) => {
  try {
    if (!(await requireTeamPlan(req, res))) return;
    if (!canManageTeam(req.userRole)) {
      return res.status(403).json({ error: "Only owners and admins can invite members" });
    }

    const { email, role, name } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });
    if (role && !ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });

    const assignedRole = role || "technician";

    // Check if already a member
    const existing = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .where("email", "==", email.toLowerCase())
      .get();

    if (!existing.empty) {
      return res.status(409).json({ error: "This person is already on your team" });
    }

    // Generate secure invite token
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const inviteExpires = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    // Get org owner info for the invite email
    const ownerDoc = await db.collection("users").doc(req.orgId).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() : {};
    const orgName = ownerData.company || ownerData.name || "SWFT";

    // Create pending team member record
    const ref = await db.collection("team").add({
      orgId: req.orgId,
      uid: null,
      email: email.toLowerCase(),
      name: name || "",
      role: assignedRole,
      status: "invited",
      inviteToken,
      inviteExpires,
      invitedAt: Date.now(),
      invitedBy: req.uid,
      joinedAt: null,
    });

    const appUrl = process.env.APP_URL || "https://goswft.com";
    const inviteUrl = `${appUrl}/swft-join?token=${inviteToken}`;

    // Send invite email via Gmail if connected
    let emailSent = false;
    if (ownerData.gmailTokens && ownerData.gmailTokens.refresh_token) {
      try {
        await sendInviteViaGmail(
          { ...ownerData, _uid: req.orgId, gmailTokens: ownerData.gmailTokens },
          email.toLowerCase(),
          inviteUrl,
          orgName,
          assignedRole,
          ownerData.companyLogo || ""
        );
        emailSent = true;
      } catch (emailErr) {
        console.error("Failed to send invite email via Gmail:", emailErr.message);
      }
    }

    res.json({
      success: true,
      id: ref.id,
      inviteUrl,
      emailSent,
      email: email.toLowerCase(),
      role: assignedRole,
      message: emailSent
        ? `Invite sent to ${email}.`
        : `Invite created for ${email}. Share the link with them to join.`,
    });
  } catch (err) { next(err); }
});

// PUT /api/team/:memberId — update a team member's role
router.put("/:memberId", async (req, res, next) => {
  try {
    if (!(await requireTeamPlan(req, res))) return;
    if (!canManageTeam(req.userRole)) {
      return res.status(403).json({ error: "Only owners and admins can update roles" });
    }

    const { role } = req.body;
    if (!role || !ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const memberDoc = await db.collection("team").doc(req.params.memberId).get();
    if (!memberDoc.exists || memberDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Member not found" });
    }

    const memberData = memberDoc.data();

    // Protected accounts can never have their role changed
    if (memberData.email && PROTECTED_EMAILS.includes(memberData.email.toLowerCase())) {
      return res.status(403).json({ error: "This account's role cannot be changed" });
    }

    const targetRole = memberData.role;
    if (!canChangeRole(req.userRole, targetRole)) {
      return res.status(403).json({ error: "You cannot change this member's role" });
    }

    // Cannot change owner's role
    if (targetRole === "owner") {
      return res.status(403).json({ error: "Cannot change the owner's role" });
    }

    await db.collection("team").doc(req.params.memberId).update({ role });

    // Also update user's role in their profile if they've joined
    if (memberData.uid) {
      await db.collection("users").doc(memberData.uid).set({ role }, { merge: true });
    }

    res.json({ success: true, role });
  } catch (err) { next(err); }
});

// DELETE /api/team/:memberId — remove a team member
router.delete("/:memberId", async (req, res, next) => {
  try {
    if (!(await requireTeamPlan(req, res))) return;
    if (!canManageTeam(req.userRole)) {
      return res.status(403).json({ error: "Only owners and admins can remove members" });
    }

    const memberDoc = await db.collection("team").doc(req.params.memberId).get();
    if (!memberDoc.exists || memberDoc.data().orgId !== req.orgId) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (memberDoc.data().role === "owner") {
      return res.status(403).json({ error: "Cannot remove the owner" });
    }

    const memberData = memberDoc.data();

    // Remove from team collection
    await db.collection("team").doc(req.params.memberId).delete();

    // Clear org from their user profile
    if (memberData.uid) {
      await db.collection("users").doc(memberData.uid).set({
        orgId: memberData.uid, // revert to solo
        role: "owner",
      }, { merge: true });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Roles & Permissions ──

const DEFAULT_PERMISSIONS = [
  // General
  { id: "dashboard.view",       label: "View Dashboard",         group: "General" },
  { id: "ai.use",               label: "Use AI Assistant",       group: "General" },
  // Customers
  { id: "customers.view",       label: "View Customers",         group: "Customers" },
  { id: "customers.add",        label: "Add Customers",          group: "Customers" },
  { id: "customers.edit",       label: "Edit Customers",         group: "Customers" },
  { id: "customers.delete",     label: "Delete Customers",       group: "Customers" },
  // Jobs
  { id: "jobs.view",            label: "View Jobs",              group: "Jobs" },
  { id: "jobs.viewAll",         label: "View All Jobs (not just assigned)", group: "Jobs" },
  { id: "jobs.add",             label: "Add Jobs",               group: "Jobs" },
  { id: "jobs.edit",            label: "Edit Jobs",              group: "Jobs" },
  { id: "jobs.delete",          label: "Delete Jobs",            group: "Jobs" },
  { id: "photos.upload",        label: "Upload Job Photos",      group: "Jobs" },
  // Quotes
  { id: "quotes.view",          label: "View Quotes",            group: "Quotes" },
  { id: "quotes.add",           label: "Create Quotes",          group: "Quotes" },
  { id: "quotes.edit",          label: "Edit Quotes",            group: "Quotes" },
  { id: "quotes.delete",        label: "Delete Quotes",          group: "Quotes" },
  // Invoices
  { id: "invoices.view",        label: "View Invoices",          group: "Invoices" },
  { id: "invoices.add",         label: "Create Invoices",        group: "Invoices" },
  { id: "invoices.edit",        label: "Edit Invoices",          group: "Invoices" },
  { id: "invoices.delete",      label: "Delete Invoices",        group: "Invoices" },
  // Schedule
  { id: "schedule.view",        label: "View Schedule",          group: "Schedule" },
  { id: "schedule.add",         label: "Add Schedule Entries",   group: "Schedule" },
  { id: "schedule.edit",        label: "Edit Schedule Entries",  group: "Schedule" },
  { id: "schedule.delete",      label: "Delete Schedule Entries",group: "Schedule" },
  // Messages
  { id: "messages.view",        label: "View Messages",          group: "Messages" },
  { id: "messages.send",        label: "Send Messages",          group: "Messages" },
  // Admin
  { id: "team.manage",          label: "Manage Team",            group: "Admin" },
  { id: "integrations.manage",  label: "Manage Integrations",    group: "Admin" },
  { id: "settings.manage",      label: "Edit Settings",          group: "Admin" },
];

const ALL_PERM_IDS = DEFAULT_PERMISSIONS.map(p => p.id);

const BUILT_IN_ROLES = {
  owner: { name: "Owner", builtIn: true, permissions: ALL_PERM_IDS },
  admin: { name: "Admin", builtIn: true, permissions: [
    "dashboard.view",
    "customers.view","customers.add","customers.edit","customers.delete",
    "jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete",
    "quotes.view","quotes.add","quotes.edit","quotes.delete",
    "invoices.view","invoices.add","invoices.edit","invoices.delete",
    "schedule.view","schedule.add","schedule.edit","schedule.delete",
    "messages.view","messages.send",
    "photos.upload",
    "ai.use",
    "team.manage","integrations.manage","settings.manage",
  ]},
  office: { name: "Office", builtIn: true, permissions: [
    "dashboard.view",
    "customers.view","customers.add","customers.edit","customers.delete",
    "jobs.view","jobs.viewAll","jobs.add","jobs.edit","jobs.delete",
    "quotes.view","quotes.add","quotes.edit","quotes.delete",
    "invoices.view","invoices.add","invoices.edit","invoices.delete",
    "schedule.view","schedule.add","schedule.edit","schedule.delete",
    "messages.view","messages.send",
    "photos.upload",
    "ai.use",
  ]},
  technician: { name: "Technician", builtIn: true, permissions: [
    "dashboard.view",
    "jobs.view","jobs.edit",
    "schedule.view",
    "messages.view","messages.send",
    // photos.upload intentionally omitted — grant via Roles & Permissions in team settings
    "ai.use",
  ]},
};

// GET /api/team/roles — get all roles and permissions for this org
router.get("/roles", async (req, res, next) => {
  try {
    const doc = await db.collection("orgRoles").doc(req.orgId).get();
    const customRoles = doc.exists ? doc.data().roles || {} : {};

    const hiddenRoles = new Set(doc.exists ? (doc.data().hiddenRoles || []) : []);

    // Merge built-in with any custom overrides, skipping hidden ones
    const roles = {};
    for (const [id, role] of Object.entries(BUILT_IN_ROLES)) {
      if (hiddenRoles.has(id)) continue;
      roles[id] = customRoles[id]
        ? { ...role, permissions: customRoles[id].permissions }
        : { ...role };
    }
    // Add custom roles
    for (const [id, role] of Object.entries(customRoles)) {
      if (!BUILT_IN_ROLES[id]) {
        roles[id] = { ...role, builtIn: false };
      }
    }

    res.json({ roles, permissions: DEFAULT_PERMISSIONS });
  } catch (err) { next(err); }
});

// POST /api/team/roles — create or update a role
router.post("/roles", async (req, res, next) => {
  try {
    if (req.userRole !== "owner") {
      return res.status(403).json({ error: "Only the owner can manage roles" });
    }

    const { roleId, name, permissions } = req.body;
    if (!roleId || !name) return res.status(400).json({ error: "Role ID and name are required" });
    if (roleId === "owner") return res.status(403).json({ error: "Cannot modify the owner role" });
    if (!Array.isArray(permissions)) return res.status(400).json({ error: "Permissions must be an array" });

    // Validate permission IDs
    const filtered = permissions.filter(p => ALL_PERM_IDS.includes(p));

    const doc = await db.collection("orgRoles").doc(req.orgId).get();
    const existing = doc.exists ? doc.data().roles || {} : {};

    existing[roleId] = {
      name,
      permissions: filtered,
      builtIn: !!BUILT_IN_ROLES[roleId],
      updatedAt: Date.now(),
    };

    const { FieldValue: FV } = require("firebase-admin/firestore");
    await db.collection("orgRoles").doc(req.orgId).set({
      roles: existing,
      // If role was previously hidden, un-hide it when explicitly saved
      hiddenRoles: FV.arrayRemove(roleId),
    }, { merge: true });

    // Invalidate permission cache for this org so changes take effect immediately
    try { require("../middleware/checkAccess").clearCustomPermCache(req.orgId); } catch (_) {}

    res.json({ success: true, roleId, permissions: filtered });
  } catch (err) { next(err); }
});

// DELETE /api/team/roles/:roleId — delete a role
router.delete("/roles/:roleId", async (req, res, next) => {
  try {
    if (req.userRole !== "owner") {
      return res.status(403).json({ error: "Only the owner can manage roles" });
    }

    const { roleId } = req.params;
    if (roleId === "owner") {
      return res.status(403).json({ error: "Cannot delete the owner role" });
    }

    // Check no members are using this role
    const memberSnap = await db.collection("team")
      .where("orgId", "==", req.orgId)
      .where("role", "==", roleId)
      .limit(1)
      .get();

    if (!memberSnap.empty) {
      return res.status(409).json({ error: "Cannot delete a role that is assigned to team members. Reassign them first." });
    }

    const { FieldValue } = require("firebase-admin/firestore");
    const orgRef = db.collection("orgRoles").doc(req.orgId);

    if (BUILT_IN_ROLES[roleId]) {
      // For built-in roles: store in a hiddenRoles list so GET filters them out
      await orgRef.set({ hiddenRoles: FieldValue.arrayUnion(roleId) }, { merge: true });
    } else {
      // For custom roles: use update() to atomically delete the nested field
      await orgRef.update({ [`roles.${roleId}`]: FieldValue.delete() });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Public routes (no auth required for validate, auth-only for join) ──
const publicRouter = require("express").Router();
const { auth: authMiddleware } = require("../middleware/auth");

// GET /api/team/invite/:token — validate an invite token (no auth)
publicRouter.get("/invite/:token", async (req, res, next) => {
  try {
    const snap = await db.collection("team")
      .where("inviteToken", "==", req.params.token)
      .where("status", "==", "invited")
      .limit(1)
      .get();

    if (snap.empty) {
      return res.json({ valid: false, error: "Invite not found or already used" });
    }

    const data = snap.docs[0].data();
    if (Date.now() > data.inviteExpires) {
      return res.json({ valid: false, error: "This invite has expired" });
    }

    const ownerDoc = await db.collection("users").doc(data.orgId).get();
    const ownerData = ownerDoc.exists ? ownerDoc.data() : {};

    res.json({
      valid: true,
      email: data.email,
      role: data.role,
      orgName: ownerData.company || ownerData.name || "SWFT",
      invitedBy: ownerData.name || "Your team owner",
    });
  } catch (err) { next(err); }
});

// POST /api/team/join — accept an invite (auth required, no checkAccess)
publicRouter.post("/join", authMiddleware, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Invite token required" });

    const snap = await db.collection("team")
      .where("inviteToken", "==", token)
      .where("status", "==", "invited")
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(404).json({ error: "Invite not found or already used" });
    }

    const memberDoc = snap.docs[0];
    const memberData = memberDoc.data();

    if (Date.now() > memberData.inviteExpires) {
      return res.status(410).json({ error: "This invite has expired. Ask your team owner to send a new one." });
    }

    const userDoc = await db.collection("users").doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Protected accounts cannot be assigned a non-owner role via invite
    const joiningEmail = req.user?.email || userData.email || "";
    if (PROTECTED_EMAILS.includes(joiningEmail.toLowerCase())) {
      return res.status(403).json({ error: "This account cannot join a team as a non-owner" });
    }

    await db.collection("team").doc(memberDoc.id).update({
      uid: req.uid,
      status: "active",
      joinedAt: Date.now(),
      inviteToken: null,
      name: userData.name || memberData.name || "",
    });

    await db.collection("users").doc(req.uid).set({
      orgId: memberData.orgId,
      role: memberData.role,
      joinedOrgAt: Date.now(),
    }, { merge: true });

    // Add owner to team record if not already there
    const ownerSnap = await db.collection("team")
      .where("orgId", "==", memberData.orgId)
      .where("uid", "==", memberData.orgId)
      .limit(1)
      .get();

    if (ownerSnap.empty) {
      const ownerDoc2 = await db.collection("users").doc(memberData.orgId).get();
      const ownerData = ownerDoc2.exists ? ownerDoc2.data() : {};
      await db.collection("team").add({
        orgId: memberData.orgId,
        uid: memberData.orgId,
        email: ownerData.email || "",
        name: ownerData.name || ownerData.company || "Owner",
        role: "owner",
        status: "active",
        joinedAt: ownerData.createdAt || Date.now(),
      });
    }

    res.json({
      success: true,
      orgId: memberData.orgId,
      role: memberData.role,
      message: "Welcome to the team!",
    });
  } catch (err) { next(err); }
});

module.exports = { router, publicRouter };
