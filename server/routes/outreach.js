/**
 * Cold Outreach Engine — System 1 from the playbook.
 *
 * Flow:
 *   1. Import leads (CSV or manual)
 *   2. AI scores each lead 0-100
 *   3. AI writes personalized email per lead
 *   4. Emails queued as "draft" — NOTHING sends without approval
 *   5. User reviews & approves/rejects in the CRM
 *   6. Approved emails send via info@goswft.com Gmail
 *   7. Follow-up sequences generate new drafts for approval
 */
const express = require("express");
const router = express.Router();
const { db } = require("../firebase");
const { sendSimpleGmail } = require("../utils/email");
const Anthropic = require("@anthropic-ai/sdk");
const claude = new Anthropic();

// ── CAN-SPAM compliance constants ──
const BASE_URL = process.env.BASE_URL || "https://goswft.com";
const COMPANY_NAME = "SWFT";
// CAN-SPAM requires a valid postal address. Set COMPANY_ADDRESS env var when available.
const PHYSICAL_ADDRESS = process.env.COMPANY_ADDRESS || "";

// ── Helper: get the outreach Gmail user (info@goswft.com) ──
async function getOutreachSender() {
  // Find the user with info@goswft.com connected
  const snap = await db.collection("users")
    .where("gmailAddress", "==", "info@goswft.com")
    .limit(1)
    .get();
  if (snap.empty) {
    // Fallback: try email field
    const snap2 = await db.collection("users")
      .where("email", "==", "info@goswft.com")
      .limit(1)
      .get();
    if (snap2.empty) throw new Error("No user found with info@goswft.com. Connect Gmail first.");
    const doc = snap2.docs[0];
    return { ...doc.data(), _uid: doc.id };
  }
  const doc = snap.docs[0];
  return { ...doc.data(), _uid: doc.id };
}

// ── POST /api/outreach/leads — Import leads (manual or batch) ──
router.post("/leads", async (req, res) => {
  try {
    const { leads } = req.body; // Array of { name, email, company, trade, website, phone, notes }
    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: "Provide an array of leads" });
    }

    const batch = db.batch();
    const imported = [];

    for (const lead of leads) {
      if (!lead.email) continue;

      // Check for duplicate
      const existing = await db.collection("outreach_leads")
        .where("email", "==", lead.email.toLowerCase().trim())
        .limit(1)
        .get();
      if (!existing.empty) continue;

      const ref = db.collection("outreach_leads").doc();
      const doc = {
        name: lead.name || "",
        email: lead.email.toLowerCase().trim(),
        company: lead.company || "",
        trade: lead.trade || "",
        website: lead.website || "",
        phone: lead.phone || "",
        notes: lead.notes || "",
        score: null, // AI scores later
        status: "new", // new → scored → emailed → replied → converted | unsubscribed
        createdAt: Date.now(),
        lastContactedAt: null,
        emailCount: 0,
      };
      batch.set(ref, doc);
      imported.push({ id: ref.id, ...doc });
    }

    await batch.commit();
    res.json({ imported: imported.length, leads: imported });
  } catch (e) {
    console.error("[outreach] Import error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/outreach/leads — List all leads ──
router.get("/leads", async (req, res) => {
  try {
    const { status, trade, minScore } = req.query;
    let query = db.collection("outreach_leads").orderBy("createdAt", "desc");

    const snap = await query.limit(500).get();
    let leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (status) leads = leads.filter(l => l.status === status);
    if (trade) leads = leads.filter(l => l.trade.toLowerCase().includes(trade.toLowerCase()));
    if (minScore) leads = leads.filter(l => (l.score || 0) >= parseInt(minScore));

    res.json({ leads, count: leads.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/outreach/leads/:id — Remove a lead ──
router.delete("/leads/:id", async (req, res) => {
  try {
    await db.collection("outreach_leads").doc(req.params.id).delete();
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/leads/bulk-delete — Delete multiple leads ──
router.post("/leads/bulk-delete", async (req, res) => {
  try {
    const { leadIds } = req.body;
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: "Provide leadIds array" });
    }

    const batch = db.batch();
    for (const id of leadIds) {
      batch.delete(db.collection("outreach_leads").doc(id));
    }
    await batch.commit();
    res.json({ deleted: leadIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/leads/bulk-status — Change status of multiple leads ──
router.post("/leads/bulk-status", async (req, res) => {
  try {
    const { leadIds, status } = req.body;
    const validStatuses = ["new", "scored", "drafted", "emailed", "replied", "converted", "unsubscribed"];
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: "Provide leadIds array" });
    }
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(", ")}` });
    }

    const batch = db.batch();
    for (const id of leadIds) {
      batch.update(db.collection("outreach_leads").doc(id), { status });
    }
    await batch.commit();
    res.json({ updated: leadIds.length, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/score — AI-score unscored leads ──
router.post("/score", async (req, res) => {
  try {
    const snap = await db.collection("outreach_leads")
      .where("score", "==", null)
      .limit(50)
      .get();

    if (snap.empty) return res.json({ scored: 0, message: "No unscored leads" });

    const leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const leadsText = leads.map(l =>
      `- ${l.name} | ${l.company} | ${l.trade} | ${l.email} | Website: ${l.website || "none"} | Notes: ${l.notes || "none"}`
    ).join("\n");

    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: `You are a lead scoring assistant for SWFT, an AI-powered CRM for home service businesses ($89-$349/month).

Score each lead 0-100 based on how likely they are to buy SWFT CRM. Consider:
- Trade type (HVAC, plumbing, roofing, landscaping, electrical, painting, cleaning, general contracting are ideal)
- Company size signals (website quality, presence)
- Whether they likely already have a CRM or are using manual methods
- How much they'd benefit from AI automation, scheduling, invoicing

Higher score = more likely to convert. Be realistic.

Leads:
${leadsText}

Respond with ONLY a JSON array: [{"email": "...", "score": N, "reason": "one sentence why"}]`
      }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("AI did not return valid JSON");

    const scores = JSON.parse(jsonMatch[0]);
    const batch = db.batch();
    let scored = 0;

    for (const s of scores) {
      const lead = leads.find(l => l.email === s.email);
      if (lead) {
        batch.update(db.collection("outreach_leads").doc(lead.id), {
          score: s.score,
          scoreReason: s.reason,
          status: "scored",
        });
        scored++;
      }
    }

    await batch.commit();
    res.json({ scored, scores });
  } catch (e) {
    console.error("[outreach] Score error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/generate — AI-generate personalized emails (drafts only) ──
router.post("/generate", async (req, res) => {
  try {
    const { limit = 15 } = req.body;

    // Get leads that haven't been emailed yet (new or scored)
    const [newSnap, scoredSnap] = await Promise.all([
      db.collection("outreach_leads").where("status", "==", "new").limit(200).get(),
      db.collection("outreach_leads").where("status", "==", "scored").limit(200).get(),
    ]);

    let leads = [
      ...newSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      ...scoredSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    ].filter(l => l.email).slice(0, limit);

    if (leads.length === 0) return res.json({ generated: 0, message: "No eligible leads" });

    const generated = [];

    for (const lead of leads) {
      const response = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: `You are writing an outreach email for Ethan, founder of SWFT. Below is the STANDARD EMAIL TEMPLATE. Your job is to customize ONLY the parts in [BRACKETS] for this specific recipient. Everything else stays essentially the same — same structure, same tone, same flow, same wording. Do NOT rewrite the email from scratch. Just fill in the personalized parts.

Recipient:
- Name: ${lead.name}
- Company: ${lead.company}
- Trade: ${lead.trade}
- Website: ${lead.website || "none"}
- Notes: ${lead.notes || "none"}

STANDARD EMAIL TEMPLATE:

Subject: [Casual subject line like "Saw your [trade] work in [city]" — just reference their trade and location. Examples: "Saw your HVAC work in Calgary", "Saw your plumbing work in Austin", "Saw your landscaping in Denver". Keep it simple and personal, NOT salesy or clever.]

Hey [First name],

I came across [Company name] and saw that [GENUINE SPECIFIC COMPLIMENT — keep it simple and general. Base it on their trade and company name, NOT on reviews or ratings. Examples: "you guys do really solid work", "looks like you're killing it", "you guys are doing great things". Keep it casual like you'd say it out loud. Do NOT mention Google reviews, star ratings, or review counts.] in the [AREA — pull the city or region from their address/notes, like "Calgary area", "Austin area", "Denver area". If no location info is available, just skip this part]. One sentence max.

I work with a lot of home service businesses and honestly the biggest thing I hear is how much time gets eaten up by the stuff that isn't the actual hands on work — [MENTION 3-4 TRADE-SPECIFIC ADMIN TASKS in casual language, like: keeping track of jobs, chasing people down for payments, getting quotes out, trying to follow up with leads]. The more time you're on the tools the better, right? That's where the money is.

So we built this thing called SWFT that basically handles all of that — scheduling, invoicing, quoting, follow-ups, customer management, job tracking. The whole back office. And it's super easy to use, like if you can send a text and talk you can run SWFT. It's AI-powered so you literally just tell it what to do and it does it.

I love seeing the work you've done, and we'd love to partner with you on this and see what you think about the software? We're happy to give a 14-day free trial if you want to mess around with it and see for yourself.

Check it out here if you're curious — goswft.com

Could you let me know what you think?

Thanks!
Ethan
ethan@goswft.com

RULES:
- Customize ONLY the [BRACKETED] sections. Keep everything else nearly identical.
- The compliment must feel simple and genuine — do NOT reference Google reviews, star ratings, or review counts
- NEVER say things like "your reviews are impressive" or "I saw your 4.8 rating"
- The admin tasks should be realistic for their specific trade
- Do NOT use exclamation marks more than once
- Do NOT sound corporate, salesy, or templated
- Do NOT include unsubscribe links (we add those separately)
- Do NOT mention specific pricing numbers
- Do NOT rewrite or restructure the email — follow the template exactly

Respond with ONLY JSON: {"subject": "...", "body": "..."}`
        }],
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const email = JSON.parse(jsonMatch[0]);

      // Save as draft — does NOT send
      const ref = db.collection("outreach_emails").doc();
      await ref.set({
        leadId: lead.id,
        leadEmail: lead.email,
        leadName: lead.name,
        leadCompany: lead.company,
        leadTrade: lead.trade,
        subject: email.subject,
        body: email.body,
        status: "draft", // draft → approved → sent | rejected
        sequence: lead.emailCount + 1, // 1 = first email, 2 = first follow-up, etc.
        createdAt: Date.now(),
        approvedAt: null,
        sentAt: null,
        gmailMessageId: null,
        gmailThreadId: null,
        rfcMessageId: null,
      });

      // Mark lead so it doesn't get re-generated
      await db.collection("outreach_leads").doc(lead.id).update({ status: "drafted" });

      generated.push({
        id: ref.id,
        to: lead.email,
        subject: email.subject,
        body: email.body,
        score: lead.score,
      });
    }

    res.json({ generated: generated.length, emails: generated });
  } catch (e) {
    console.error("[outreach] Generate error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/outreach/drafts — List emails pending approval ──
router.get("/drafts", async (req, res) => {
  try {
    const snap = await db.collection("outreach_emails")
      .where("status", "==", "draft")
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const drafts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ drafts, count: drafts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/outreach/emails — List all outreach emails ──
router.get("/emails", async (req, res) => {
  try {
    const { status } = req.query;
    let query = db.collection("outreach_emails").orderBy("createdAt", "desc");
    const snap = await query.limit(200).get();
    let emails = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (status) emails = emails.filter(e => e.status === status);
    res.json({ emails, count: emails.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/approve — Approve emails for sending (CAN-SPAM compliant) ──
router.post("/approve", async (req, res) => {
  try {
    const { emailIds } = req.body; // Array of outreach_email doc IDs
    if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ error: "Provide emailIds array" });
    }

    const sender = await getOutreachSender();
    if (!sender.gmailTokens) {
      return res.status(400).json({ error: "info@goswft.com Gmail not connected. Connect Gmail OAuth first." });
    }

    const results = [];
    for (const emailId of emailIds) {
      const doc = await db.collection("outreach_emails").doc(emailId).get();
      if (!doc.exists || doc.data().status !== "draft") {
        results.push({ id: emailId, status: "skipped", reason: "not a draft" });
        continue;
      }

      const email = doc.data();

      // ── Suppression check: skip if lead unsubscribed since draft was created ──
      const leadDoc = await db.collection("outreach_leads").doc(email.leadId).get();
      if (!leadDoc.exists || leadDoc.data().status === "unsubscribed") {
        await db.collection("outreach_emails").doc(emailId).update({ status: "rejected" });
        results.push({ id: emailId, status: "skipped", reason: "lead unsubscribed" });
        continue;
      }

      // ── Build CAN-SPAM compliant footer ──
      const unsubUrl = `${BASE_URL}/unsubscribe?id=${email.leadId}`;

      const addressLine = PHYSICAL_ADDRESS ? `<p style="margin: 0 0 4px;">${COMPANY_NAME} &mdash; ${PHYSICAL_ADDRESS}</p>` : "";
      const addressText = PHYSICAL_ADDRESS ? `${COMPANY_NAME} — ${PHYSICAL_ADDRESS}\n` : "";

      const htmlBody = `
        <div style="font-family: sans-serif; font-size: 15px; line-height: 1.6; color: #333;">
          ${email.body.split("\n").map(p => `<p>${p}</p>`).join("")}
        </div>
        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #999; line-height: 1.5;">
          ${addressLine}
          <p style="margin: 0;">Not interested? <a href="${unsubUrl}" style="color: #666; text-decoration: underline;">Unsubscribe</a> — you won't hear from us again.</p>
        </div>
      `;

      const textFooter = `\n\n---\n${addressText}Not interested? Unsubscribe here: ${unsubUrl}`;

      // ── List-Unsubscribe headers (required by Gmail/Yahoo for bulk senders) ──
      const extraHeaders = {
        "List-Unsubscribe": `<${unsubUrl}>, <mailto:info@goswft.com?subject=Unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      };

      try {
        const result = await sendSimpleGmail(
          sender,
          email.leadEmail,
          email.subject,
          email.body + textFooter,
          htmlBody,
          { extraHeaders }
        );

        await db.collection("outreach_emails").doc(emailId).update({
          status: "sent",
          approvedAt: Date.now(),
          sentAt: Date.now(),
          gmailMessageId: result.messageId,
          gmailThreadId: result.threadId,
          rfcMessageId: result.rfcMessageId,
        });

        // Update lead status and contact count
        await db.collection("outreach_leads").doc(email.leadId).update({
          status: "emailed",
          lastContactedAt: Date.now(),
          emailCount: (email.sequence || 1),
          lastThreadId: result.threadId,
          lastRfcMessageId: result.rfcMessageId,
        });

        results.push({ id: emailId, status: "sent", to: email.leadEmail });

        // Small delay between sends to avoid Gmail rate limits
        await new Promise(r => setTimeout(r, 2000));

      } catch (sendErr) {
        await db.collection("outreach_emails").doc(emailId).update({
          status: "draft", // Keep as draft so user can retry
          error: sendErr.message,
        });
        results.push({ id: emailId, status: "failed", error: sendErr.message });
      }
    }

    res.json({ results, sent: results.filter(r => r.status === "sent").length });
  } catch (e) {
    console.error("[outreach] Approve/send error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/outreach/draft/:id — Edit a draft email ──
router.put("/draft/:id", async (req, res) => {
  try {
    const { subject, body } = req.body;
    const doc = await db.collection("outreach_emails").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Draft not found" });
    if (doc.data().status !== "draft") return res.status(400).json({ error: "Can only edit drafts" });

    const updates = {};
    if (subject !== undefined) updates.subject = subject;
    if (body !== undefined) updates.body = body;
    updates.editedAt = Date.now();

    await db.collection("outreach_emails").doc(req.params.id).update(updates);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/reject — Reject draft emails & reset lead status ──
router.post("/reject", async (req, res) => {
  try {
    const { emailIds } = req.body;
    if (!emailIds || !Array.isArray(emailIds)) return res.status(400).json({ error: "Provide emailIds" });

    const batch = db.batch();
    for (const id of emailIds) {
      const emailDoc = await db.collection("outreach_emails").doc(id).get();
      batch.update(db.collection("outreach_emails").doc(id), { status: "rejected" });

      // Reset lead status so it can be re-generated
      if (emailDoc.exists) {
        const leadId = emailDoc.data().leadId;
        if (leadId) {
          const leadDoc = await db.collection("outreach_leads").doc(leadId).get();
          if (leadDoc.exists && leadDoc.data().status === "drafted") {
            const hasScore = leadDoc.data().score != null;
            batch.update(db.collection("outreach_leads").doc(leadId), {
              status: hasScore ? "scored" : "new",
            });
          }
        }
      }
    }
    await batch.commit();

    res.json({ rejected: emailIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/followup — Generate follow-up emails for non-responders ──
router.post("/followup", async (req, res) => {
  try {
    const { daysAfter = 3 } = req.body;
    const cutoff = Date.now() - (daysAfter * 24 * 60 * 60 * 1000);

    // Find leads that were emailed but haven't been contacted recently
    const snap = await db.collection("outreach_leads")
      .where("status", "==", "emailed")
      .limit(200)
      .get();

    const eligible = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(l => l.lastContactedAt && l.lastContactedAt < cutoff && (l.emailCount || 0) < 3); // Max 3 emails per lead

    if (eligible.length === 0) return res.json({ generated: 0, message: "No leads ready for follow-up" });

    const generated = [];

    for (const lead of eligible.slice(0, 15)) {
      // Get the previous email for context
      const prevSnap = await db.collection("outreach_emails")
        .where("leadId", "==", lead.id)
        .where("status", "==", "sent")
        .orderBy("sentAt", "desc")
        .limit(1)
        .get();

      const prevEmail = prevSnap.empty ? null : prevSnap.docs[0].data();
      const sequenceNum = (lead.emailCount || 1) + 1;

      const anglePrompts = {
        2: "Take a different angle than the first email. Maybe mention a specific pain point for their trade, or share a quick stat about how much time CRM saves. Remind them about the 14-day free trial — zero risk to try it out.",
        3: "This is the final follow-up. Be very brief (2-3 sentences). Respectful breakup email — say something like 'figured this wasn't the right time, no hard feelings' with a final soft CTA. Mention the free trial one last time.",
      };

      const response = await claude.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `You are Ethan, founder of SWFT — an AI-powered CRM built for home service businesses. You're writing a follow-up email (#${sequenceNum - 1}) to someone who didn't reply to your first outreach.

Your voice: You sound like a real person texting a friend who runs a business — chill, direct, no fluff. Short sentences. You don't sound like a marketer or a bot. You write like someone who's been in the trenches and gets it.

Recipient:
- Name: ${lead.name}
- Company: ${lead.company}
- Trade: ${lead.trade}

Previous email subject: "${prevEmail?.subject || "N/A"}"
${anglePrompts[sequenceNum] || "Take a different angle."}

Rules:
- Short subject line (under 50 chars), feels like a natural follow-up
- 2-4 sentences max. Keep the same casual, human tone.
- Sign off as "Ethan" (no last name, no title)
- Do NOT start with "Just following up" or "Just checking in" or "Hope you're doing well"
- Do NOT sound corporate or templated
- Do NOT include unsubscribe links (we add those separately)

Respond with ONLY JSON: {"subject": "...", "body": "..."}`
        }],
      });

      const text = response.content[0].text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const email = JSON.parse(jsonMatch[0]);

      const ref = db.collection("outreach_emails").doc();
      await ref.set({
        leadId: lead.id,
        leadEmail: lead.email,
        leadName: lead.name,
        leadCompany: lead.company,
        leadTrade: lead.trade,
        subject: email.subject,
        body: email.body,
        status: "draft",
        sequence: sequenceNum,
        isFollowUp: true,
        previousThreadId: lead.lastThreadId || null,
        previousRfcMessageId: lead.lastRfcMessageId || null,
        createdAt: Date.now(),
        approvedAt: null,
        sentAt: null,
      });

      generated.push({ id: ref.id, to: lead.email, subject: email.subject, sequence: sequenceNum });
    }

    res.json({ generated: generated.length, emails: generated });
  } catch (e) {
    console.error("[outreach] Follow-up error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/outreach/unsubscribe — Mark a lead as unsubscribed ──
router.post("/unsubscribe", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Provide email" });

    const snap = await db.collection("outreach_leads")
      .where("email", "==", email.toLowerCase().trim())
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({ status: "unsubscribed" });
    }

    res.json({ unsubscribed: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/outreach/stats — Campaign statistics ──
router.get("/stats", async (req, res) => {
  try {
    const [leadsSnap, emailsSnap] = await Promise.all([
      db.collection("outreach_leads").get(),
      db.collection("outreach_emails").get(),
    ]);

    const leads = leadsSnap.docs.map(d => d.data());
    const emails = emailsSnap.docs.map(d => d.data());

    res.json({
      leads: {
        total: leads.length,
        new: leads.filter(l => l.status === "new").length,
        scored: leads.filter(l => l.status === "scored").length,
        emailed: leads.filter(l => l.status === "emailed").length,
        converted: leads.filter(l => l.status === "converted").length,
        unsubscribed: leads.filter(l => l.status === "unsubscribed").length,
        avgScore: leads.filter(l => l.score).reduce((sum, l) => sum + l.score, 0) / (leads.filter(l => l.score).length || 1),
      },
      emails: {
        total: emails.length,
        drafts: emails.filter(e => e.status === "draft").length,
        sent: emails.filter(e => e.status === "sent").length,
        rejected: emails.filter(e => e.status === "rejected").length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Lead Finder — Auto-discover leads via Google Places ──
const DEFAULT_TRADES = ["plumber", "HVAC", "roofer", "electrician", "landscaper", "painter", "cleaner", "general contractor"];

async function extractEmailFromWebsite(websiteUrl) {
  try {
    const url = websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SWFT Lead Finder)" },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const html = await res.text();

    // Extract emails via regex — check mailto links first, then raw text
    const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
    const found = [...new Set((html.match(emailRegex) || []))];

    // Filter out junk emails
    const junk = ["noreply", "no-reply", "example.com", "sentry.io", "wixpress", "wordpress", "googleapis", "gravatar", "schema.org", ".png", ".jpg", ".svg", ".css", ".js"];
    const valid = found.filter(e => !junk.some(j => e.toLowerCase().includes(j)));

    // Prefer info@, contact@, hello@, owner name emails; avoid generic support@
    const preferred = valid.find(e => /^(info|contact|hello|admin|office)@/i.test(e));
    return preferred || valid[0] || null;
  } catch (_) {
    return null;
  }
}

async function findLeads({ location = "Austin, TX", trades = DEFAULT_TRADES, limit = 15 } = {}) {
  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!MAPS_KEY) throw new Error("GOOGLE_MAPS_API_KEY not configured.");

  // Get existing lead emails for dedup
  const existingSnap = await db.collection("outreach_leads").get();
  const existingEmails = new Set(existingSnap.docs.map(d => d.data().email?.toLowerCase()));

  const imported = [];
  const skipped = { noWebsite: 0, noEmail: 0, duplicate: 0 };

  // Cycle through trades until we hit the limit
  for (const trade of trades) {
    if (imported.length >= limit) break;

    const query = `${trade} in ${location}`;
    const placesRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": MAPS_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.rating,places.userRatingCount",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 20 }),
    });

    if (!placesRes.ok) {
      console.error(`[outreach] Places API error for "${query}":`, await placesRes.text());
      continue;
    }

    const placesData = await placesRes.json();
    const places = placesData.places || [];

    for (const place of places) {
      if (imported.length >= limit) break;

      const name = place.displayName?.text || "";
      const website = place.websiteUri || "";
      const phone = place.nationalPhoneNumber || "";
      const address = place.formattedAddress || "";
      const rating = place.rating || null;
      const reviewCount = place.userRatingCount || 0;

      if (!website) { skipped.noWebsite++; continue; }

      const email = await extractEmailFromWebsite(website);
      if (!email) { skipped.noEmail++; continue; }
      if (existingEmails.has(email.toLowerCase())) { skipped.duplicate++; continue; }

      // Extract city from address (typically "123 Main St, City, State/Province Zip, Country")
      const addressParts = address.split(",").map(s => s.trim());
      const city = addressParts.length >= 2 ? addressParts[addressParts.length - 3] || addressParts[0] : "";

      const ref = db.collection("outreach_leads").doc();
      const lead = {
        name: name,
        email: email.toLowerCase().trim(),
        company: name,
        trade: trade,
        website: website.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        phone: phone,
        city: city,
        address: address,
        rating: rating,
        reviewCount: reviewCount,
        notes: `Auto-discovered via Google Places.`,
        score: null,
        status: "new",
        createdAt: Date.now(),
        lastContactedAt: null,
        emailCount: 0,
        source: "auto-places",
      };
      await ref.set(lead);
      existingEmails.add(email.toLowerCase());
      imported.push({ id: ref.id, ...lead });
    }
  }

  console.log(`[outreach] Lead finder: imported ${imported.length}, skipped ${JSON.stringify(skipped)}`);
  return { imported: imported.length, skipped, leads: imported };
}

router.post("/find-leads", async (req, res) => {
  try {
    const { location, trades, limit } = req.body;
    const result = await findLeads({ location, trades, limit });
    res.json(result);
  } catch (e) {
    console.error("[outreach] Find leads error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Export findLeads for the daily worker
router.findLeads = findLeads;

module.exports = router;
