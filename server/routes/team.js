// ════════════════════════════════════════════════
// Team Routes — multi-user team management
// ════════════════════════════════════════════════

const router = require("express").Router();
const { db } = require("../firebase");
const crypto = require("crypto");

const ROLES = ["owner", "admin", "technician", "office"];

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

    // TODO: Send invite email via Postmark/Gmail
    // For now, return the invite link so owner can share it manually
    const appUrl = process.env.APP_URL || "https://goswft.com";
    const inviteUrl = `${appUrl}/swft-join?token=${inviteToken}`;

    res.json({
      success: true,
      id: ref.id,
      inviteUrl,
      email: email.toLowerCase(),
      role: assignedRole,
      message: `Invite created for ${email}. Share the link with them to join.`,
    });
  } catch (err) { next(err); }
});

// PUT /api/team/:memberId — update a team member's role
router.put("/:memberId", async (req, res, next) => {
  try {
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

    const targetRole = memberDoc.data().role;
    if (!canChangeRole(req.userRole, targetRole)) {
      return res.status(403).json({ error: "You cannot change this member's role" });
    }

    // Cannot change owner's role
    if (targetRole === "owner") {
      return res.status(403).json({ error: "Cannot change the owner's role" });
    }

    await db.collection("team").doc(req.params.memberId).update({ role });

    // Also update user's role in their profile if they've joined
    const memberData = memberDoc.data();
    if (memberData.uid) {
      await db.collection("users").doc(memberData.uid).set({ role }, { merge: true });
    }

    res.json({ success: true, role });
  } catch (err) { next(err); }
});

// DELETE /api/team/:memberId — remove a team member
router.delete("/:memberId", async (req, res, next) => {
  try {
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

// POST /api/team/join — accept an invite (called after user creates account)
router.post("/join", async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Invite token required" });

    // Find the invite
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

    // Get the invitee's email from their Firebase account
    const userDoc = await db.collection("users").doc(req.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Activate the member
    await db.collection("team").doc(memberDoc.id).update({
      uid: req.uid,
      status: "active",
      joinedAt: Date.now(),
      inviteToken: null,
      name: userData.name || memberData.name || "",
    });

    // Update the user's profile to join this org
    await db.collection("users").doc(req.uid).set({
      orgId: memberData.orgId,
      role: memberData.role,
      joinedOrgAt: Date.now(),
    }, { merge: true });

    // Also add owner to their org's team record if not already there
    const ownerSnap = await db.collection("team")
      .where("orgId", "==", memberData.orgId)
      .where("uid", "==", memberData.orgId)
      .limit(1)
      .get();

    if (ownerSnap.empty) {
      const ownerDoc = await db.collection("users").doc(memberData.orgId).get();
      const ownerData = ownerDoc.exists ? ownerDoc.data() : {};
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

// GET /api/team/invite/:token — validate an invite token (no auth required)
router.get("/invite/:token", async (req, res, next) => {
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

    // Get org name
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

module.exports = router;
