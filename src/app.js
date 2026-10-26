import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentTurn } from "./agent.js";
import { ADJUSTMENT_RULES, needsApproval, PricingError, supportsArea } from "./pricing.js";
import { applyJob } from "./tools.js";
import { can, PERMISSIONS, ROLES } from "./auth.js";
import { DELIVERY_REQUIREMENTS, HttpError, MATERIAL_UNITS, VAT_TREATMENTS } from "./catalog.js";
import { RATE_PATHS, VARIABLE_KINDS } from "./variables.js";
import { extractProduct } from "./productAi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_MESSAGE_CHARS = 4000;
const MAX_CUSTOMER_MESSAGES = 150;

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

// What the chat shows of a quotation.
const publicQuote = (q) => ({
  id: q.id,
  number: q.number,
  customer: q.customer,
  projectName: q.projectName,
  siteAddress: q.siteAddress,
  status: q.status,
  projectSummary: q.projectSummary,
  notes: q.notes,
  job: q.job,
  details: q.details,
  lines: q.lines,
  currency: q.currency,
  subtotal: q.subtotal,
  discountPercent: q.discountPercent,
  discount: q.discount,
  taxRatePercent: q.taxRatePercent,
  tax: q.tax,
  total: q.total,
  validUntil: q.validUntil,
  createdAt: q.createdAt,
  updatedAt: q.updatedAt,
});

// The editor gets everything except the frozen rate card (it can be large).
const editorQuote = ({ pricingSnapshot, ...q }) => ({
  ...q,
  snapshotSettings: pricingSnapshot?.settings ?? null,
});

const adminConversationSummary = (c, quotes) => ({
  id: c.id,
  status: c.status,
  aiPaused: !!c.aiPaused,
  customer: c.customer,
  escalation: c.escalation,
  messageCount: c.transcript.filter((t) => t.role === "customer").length,
  lastMessage: [...c.transcript].reverse().find((t) => t.text)?.text?.slice(0, 140) ?? "",
  quoteTotal: quotes.filter((q) => q.status !== "draft").reduce((s, q) => s + q.total, 0),
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

// Choices for the job form and the quotation editor, from the live price list.
const formOptions = ({ rates, catalog, categories }) => {
  const names = (table) => Object.entries(table).map(([key, v]) => ({ key, name: v.name }));
  return {
    categories: categories.filter((c) => c.kind === "material").map(({ key, name }) => ({ key, name })),
    products: Object.entries(rates.products).map(([key, p]) => ({
      key,
      name: p.name,
      sku: p.sku,
      category: p.category,
      unit: p.unit,
      unitPrice: p.unitPrice,
      size: p.size,
      sizeVerified: !!p.sizeVerified,
      coveragePerM2: p.coveragePerM2,
      colour: p.colour ?? null,
      finish: p.finish ?? null,
      colourOptions: p.colourOptions ?? null,
      finishOptions: p.finishOptions ?? null,
      unitsPerPallet: p.unitsPerPallet,
      defaultWastagePercent: p.defaultWastagePercent ?? null,
      deliveryRequirement: p.deliveryRequirement ?? "none",
      hasLabourRate: !!p.labour,
      supportsArea: supportsArea(p),
    })),
    extras: catalog.filter((c) => c.active !== false).map(({ sku, name, unit, unitPrice, kind, minQuantity }) => ({
      sku, name, unit, unitPrice, kind, minQuantity: minQuantity ?? 1,
    })),
    colours: Object.entries(rates.colours).map(([key, v]) => ({ key, name: v.name, surcharge: v.surcharge })),
    finishes: Object.entries(rates.finishes).map(([key, v]) => ({ key, name: v.name, surcharge: v.surcharge })),
    wastageOptions: rates.wastageOptions,
    vehicles: names(rates.delivery.vehicles),
    offloading: names(rates.offloading),
    slope: names(rates.slope),
    groundPrep: names(rates.groundPrep),
    discounts: Object.entries(rates.discounts).map(([key, v]) => ({ key, name: v.name, percent: v.percent })),
  };
};

// Company details printed on the quotation document.
const quoteDocumentSettings = (s) => ({
  companyName: s.companyName,
  tagline: s.companyTagline,
  address: s.companyAddress,
  phone: s.companyPhone,
  email: s.companyEmail,
  website: s.companyWebsite,
  subtitle: s.quoteSubtitle,
  signatory: s.quoteSignatory,
  signatoryTitle: s.quoteSignatoryTitle,
  terms: s.quoteTerms,
  validDays: s.quoteValidDays,
});

/**
 * @param {object} options
 * @param {object} [options.demo]  From createDemo(): enables the public demo.
 * @param {boolean} [options.demoMode]  True for the app instance serving one demo sandbox.
 */
export function createApp({ store, getClient, provider = "openai", demo = null, demoMode = false }) {
  const app = express();
  // Behind Railway's proxy: take the visitor's address from the one proxy hop.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "500kb" }));
  app.use(express.static(path.join(here, "..", "public"), { extensions: ["html"] }));
  // PDF export library for the quotation download.
  app.use("/vendor", express.static(path.join(here, "..", "node_modules", "html2pdf.js", "dist")));

  const busy = new Set();
  const now = () => new Date().toISOString();

  // ---------- Public demo ----------
  // Demo visitors get their own sandbox; requests carrying a demo token are
  // handed to it before any real data is touched.
  app.get("/api/demo", (_req, res) => res.json({ enabled: !!demo }));
  if (demo) {
    app.post("/api/demo/start", demo.start);
    app.use("/api", demo.gate);
  }

  // ---------- Staff sign-in ----------

  const bearer = (req) => (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

  // Every API route except sign-in needs a signed-in employee.
  const requireStaff = async (req, res, next) => {
    req.user = await store.auth.userForToken(bearer(req));
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    next();
  };
  const requirePermission = (permission) => (req, res, next) => {
    if (!can(req.user, permission)) {
      return res.status(403).json({ error: `You don't have permission to do this (${PERMISSIONS[permission]}).` });
    }
    next();
  };

  app.post("/api/auth/login", async (req, res) => {
    const { token, user } = await store.auth.login(req.body?.username, req.body?.password);
    res.json({ token, user });
  });

  app.use("/api", (req, res, next) => (req.path === "/auth/login" || req.path === "/demo" ? next() : requireStaff(req, res, next)));

  app.post("/api/auth/logout", async (req, res) => {
    await store.auth.logout(bearer(req));
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const s = await store.getSettings();
    res.json({ user: req.user, companyName: s.companyName, currency: s.currency, demo: demoMode });
  });

  app.post("/api/auth/password", async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const check = await store.auth.login(req.user.username, currentPassword).catch(() => null);
    if (!check) return res.status(400).json({ error: "Your current password is wrong." });
    await store.auth.logout(check.token);
    await store.auth.updateUser(req.user.id, { password: newPassword }, req.user);
    // Changing the password signs out every session, so start a new one.
    res.json(await store.auth.login(req.user.username, newPassword));
  });

  // ---------- Live updates (Server-Sent Events) ----------

  app.get("/api/events", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    res.write(": connected\n\n");
    const unsubscribe = store.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(ping);
    });
  });

  // ---------- Quoting assistant chat ----------

  const loadConversation = async (req, res) => {
    const conv = await store.getConversation(req.params.id);
    const token = req.get("x-conversation-token") ?? "";
    if (!conv || !safeEqual(conv.token, token)) {
      res.status(404).json({ error: "Conversation not found" });
      return null;
    }
    return conv;
  };

  const chatQuotes = async (conv) => {
    const list = await store.quotations.list({ conversationId: conv.id });
    const full = await Promise.all(list.filter((q) => q.status !== "draft").map((q) => store.quotations.get(q.id)));
    return full.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(publicQuote);
  };

  const customerView = async (conv) => {
    const [settings, pricing, quotes] = await Promise.all([store.getSettings(), store.getPricingContext(), chatQuotes(conv)]);
    return {
      id: conv.id,
      status: conv.status,
      companyName: settings.companyName,
      currency: settings.currency,
      customer: conv.customer,
      quoteDocument: quoteDocumentSettings(settings),
      transcript: conv.transcript,
      quotes,
      job: conv.job ?? null,
      draftQuotationId: conv.draftQuotationId ?? null,
      formOptions: formOptions(pricing),
    };
  };

  // Runs the agent on whatever is pending and sends the updated chat.
  const replyWithAgent = async (conv, req, res) => {
    if (conv.aiPaused) return res.json(await customerView(conv));
    busy.add(conv.id);
    try {
      await runAgentTurn({ client: getClient(), provider, store, conv, user: req.user });
      res.json(await customerView(conv));
    } catch (err) {
      console.error("Agent turn failed", err);
      await store.touch(conv).catch(() => {});
      res.status(502).json({
        error: "The assistant is having trouble right now. Your message was saved and our team can see it.",
        ...(await customerView(conv)),
      });
    } finally {
      busy.delete(conv.id);
    }
  };

  app.post("/api/chat", async (req, res) => {
    const conv = await store.createConversation(req.user.id);
    const { companyName } = await store.getSettings();
    conv.transcript.push({
      role: "agent",
      text: `Hi ${req.user.name.split(" ")[0]}! I'm the ${companyName} quoting assistant. Fill in the job form (or describe the job here) and I'll price it for you.`,
      at: now(),
    });
    await store.touch(conv);
    res.status(201).json({ token: conv.token, ...(await customerView(conv)) });
  });

  app.get("/api/chat/:id", async (req, res) => {
    const conv = await loadConversation(req, res);
    if (conv) res.json(await customerView(conv));
  });

  app.post("/api/chat/:id/messages", async (req, res) => {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Message is empty" });
    if (text.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters` });
    }
    if (conv.status === "closed") return res.status(409).json({ error: "This conversation is closed" });
    if (conv.transcript.filter((t) => t.role === "customer").length >= MAX_CUSTOMER_MESSAGES) {
      return res.status(429).json({ error: "This conversation is too long, please start a new one" });
    }
    if (busy.has(conv.id)) return res.status(409).json({ error: "Still replying to your last message" });

    conv.transcript.push({ role: "customer", text, at: now(), by: req.user.name });
    (conv.pending ??= []).push(text);
    await store.touch(conv);
    await replyWithAgent(conv, req, res);
  });

  // The job form: price it straight away, then let the agent review it.
  app.post("/api/chat/:id/job", async (req, res) => {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    if (conv.status === "closed") return res.status(409).json({ error: "This conversation is closed" });
    if (busy.has(conv.id)) return res.status(409).json({ error: "Still replying to your last message" });
    const estimate = await applyJob(req.body?.job, { store, conv, user: req.user }, "form");
    (conv.pending ??= []).push(
      `<job_form>The employee submitted the job form. It is saved and priced.\n` +
        `Job: ${JSON.stringify(conv.job)}\nEstimate: ${JSON.stringify(estimate)}</job_form>`,
    );
    await store.touch(conv);
    await replyWithAgent(conv, req, res);
  });

  // "New chat" deletes the old conversation. Its quotations stay under Quotations.
  app.delete("/api/chat/:id", async (req, res) => {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    if (busy.has(conv.id)) return res.status(409).json({ error: "Still replying to your last message" });
    await store.deleteConversation(conv.id);
    res.json({ deleted: true });
  });

  app.post("/api/chat/:id/quotes/:quoteId/accept", async (req, res) => {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const quote = await store.quotations.get(req.params.quoteId);
    if (!quote || quote.conversationId !== conv.id) return res.status(404).json({ error: "Quote not found" });
    if (quote.status !== "sent") return res.status(409).json({ error: "This quote can't be accepted yet" });
    await store.quotations.setStatus(quote.id, { status: "accepted", version: quote.version, user: req.user });
    conv.transcript.push({ role: "event", type: "accepted", quoteId: quote.id, number: quote.number, at: now() });
    (conv.pending ??= []).push(`<system_update>The employee marked quote ${quote.number} as accepted by the customer.</system_update>`);
    await store.touch(conv);
    res.json(await customerView(conv));
  });

  // ---------- Catalogue and pricing ----------

  app.get("/api/catalog", async (req, res) => {
    const manage = can(req.user, "manage_pricing");
    const [categories, products, variables, settings] = await Promise.all([
      store.listCategories(), store.listProducts({ includeInactive: manage }), store.listVariables(), store.getSettings(),
    ]);
    res.json({
      categories,
      products,
      variables: manage ? variables : variables.filter((v) => v.active),
      settings: { currency: settings.currency, taxRatePercent: settings.taxRatePercent, maxDiscountPercent: settings.maxDiscountPercent, autoApproveLimit: settings.autoApproveLimit },
      schema: {
        variableKinds: VARIABLE_KINDS,
        ratePaths: RATE_PATHS,
        adjustmentRules: ADJUSTMENT_RULES,
        materialUnits: MATERIAL_UNITS,
        vatTreatments: VAT_TREATMENTS,
        deliveryRequirements: DELIVERY_REQUIREMENTS,
      },
    });
  });

  app.get("/api/form-options", async (_req, res) => {
    const pricing = await store.getPricingContext();
    res.json({ formOptions: formOptions(pricing), quoteDocument: quoteDocumentSettings(pricing.settings), currency: pricing.settings.currency });
  });

  app.get("/api/products/:id/history", async (req, res) => {
    res.json(await store.priceHistory(req.params.id));
  });

  app.post("/api/products", requirePermission("manage_pricing"), async (req, res) => {
    res.status(201).json(await store.createProduct(req.body ?? {}, req.user));
  });

  app.put("/api/products/:id", requirePermission("manage_pricing"), async (req, res) => {
    const { version, ...input } = req.body ?? {};
    res.json(await store.updateProduct(req.params.id, input, version, req.user));
  });

  app.post("/api/products/extract", requirePermission("manage_pricing"), async (req, res) => {
    const categories = await store.listCategories();
    try {
      res.json(await extractProduct({ client: getClient(), provider, text: req.body?.text, categories }));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      console.error("Product extraction failed", err);
      res.status(502).json({ error: "The assistant couldn't read that description right now. Fill in the form instead, or try again." });
    }
  });

  app.post("/api/pricing-variables", requirePermission("manage_pricing"), async (req, res) => {
    res.status(201).json(await store.createVariable(req.body ?? {}, req.user));
  });

  app.put("/api/pricing-variables/:id", requirePermission("manage_pricing"), async (req, res) => {
    const { version, ...input } = req.body ?? {};
    res.json(await store.updateVariable(req.params.id, input, version, req.user));
  });

  // ---------- Quotations ----------

  const getQuotation = async (req, res) => {
    const includeDeleted = can(req.user, "delete_quotations") && req.query.deleted === "1";
    const q = await store.quotations.get(req.params.id, { includeDeleted });
    if (!q) res.status(404).json({ error: "Quotation not found" });
    return q;
  };

  app.get("/api/quotations", async (req, res) => {
    const deleted = req.query.deleted === "1";
    if (deleted && !can(req.user, "delete_quotations")) {
      return res.status(403).json({ error: "You don't have permission to see deleted quotations." });
    }
    res.json(await store.quotations.list({ search: String(req.query.search ?? ""), status: String(req.query.status ?? ""), deleted }));
  });

  app.get("/api/quotations/:id", async (req, res) => {
    const q = await getQuotation(req, res);
    if (q) res.json(editorQuote(q));
  });

  // Recalculates unsaved edits so the editor can show live totals.
  app.post("/api/quotations/:id/preview", async (req, res) => {
    const q = await getQuotation(req, res);
    if (!q) return;
    const { pricing } = await store.quotations.price({ ...q, ...(req.body?.input ?? {}) }, { snapshot: q.pricingSnapshot });
    res.json(pricing);
  });

  const priceEditsAllowed = (user, saved, input) => {
    if (can(user, "override_prices")) return true;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return (input.overrides === undefined || same(input.overrides, saved.overrides)) &&
      (input.customLines === undefined || same(input.customLines, saved.customLines));
  };

  app.put("/api/quotations/:id", async (req, res) => {
    const saved = await getQuotation(req, res);
    if (!saved) return;
    const { version, input = {} } = req.body ?? {};
    if (saved.status === "accepted" && !can(req.user, "approve_quotations")) {
      return res.status(403).json({ error: "This quotation was accepted by the customer; only a manager can change it." });
    }
    if (!priceEditsAllowed(req.user, saved, input)) {
      return res.status(403).json({ error: "You don't have permission to change line prices or add manual lines." });
    }
    const settings = await store.getSettings();
    const approver = can(req.user, "approve_quotations");
    const full = await store.quotations.update(saved.id, {
      input,
      version,
      user: req.user,
      // An approved quotation that now needs approval goes back to a manager.
      statusFor: (pricing, current) =>
        current.status === "sent" && !approver && needsApproval(pricing, settings) ? "pending_review" : current.status,
      summary: String(req.body?.summary ?? "").slice(0, 300),
    });
    res.json(editorQuote(full));
  });

  // Issue a draft, approve, decline or record the customer's acceptance.
  app.post("/api/quotations/:id/status", async (req, res) => {
    const saved = await getQuotation(req, res);
    if (!saved) return;
    const { action, version, staffNote } = req.body ?? {};
    const settings = await store.getSettings();
    let status;
    if (action === "issue") {
      if (saved.status !== "draft") return res.status(409).json({ error: "Only drafts can be issued." });
      if (!saved.customer?.name) return res.status(400).json({ error: "Add the customer's name before issuing the quotation." });
      status = needsApproval(saved, settings) && !can(req.user, "approve_quotations") ? "pending_review" : "sent";
    } else if (action === "approve" || action === "decline") {
      if (!can(req.user, "approve_quotations")) return res.status(403).json({ error: "Only a manager can approve or decline quotations." });
      if (!["pending_review", "sent", "rejected"].includes(saved.status)) return res.status(409).json({ error: "This quotation isn't waiting for approval." });
      status = action === "approve" ? "sent" : "rejected";
    } else if (action === "accept") {
      if (saved.status !== "sent") return res.status(409).json({ error: "Only approved quotations can be marked as accepted." });
      status = "accepted";
    } else {
      return res.status(400).json({ error: "action must be issue, approve, decline or accept" });
    }
    const full = await store.quotations.setStatus(saved.id, { status, version, user: req.user, staffNote });
    // Let the assistant chat know about manager decisions.
    const conv = saved.conversationId && (await store.getConversation(saved.conversationId));
    if (conv && ["approve", "decline"].includes(action)) {
      const label = action === "approve" ? "approved" : "declined";
      conv.transcript.push({ role: "event", type: "quote_status", quoteId: saved.id, number: saved.number, text: label, at: now() });
      (conv.pending ??= []).push(
        `<system_update>Staff ${label} quote ${saved.number} (${saved.id}).${staffNote ? ` Note: ${staffNote}` : ""}</system_update>`,
      );
      await store.touch(conv);
    }
    res.json(editorQuote(full));
  });

  app.get("/api/quotations/:id/compare", async (req, res) => {
    const q = await getQuotation(req, res);
    if (q) res.json(await store.quotations.compareWithCurrent(q.id));
  });

  app.post("/api/quotations/:id/refresh", async (req, res) => {
    const saved = await getQuotation(req, res);
    if (!saved) return;
    if (saved.status === "accepted" && !can(req.user, "approve_quotations")) {
      return res.status(403).json({ error: "This quotation was accepted by the customer; only a manager can change it." });
    }
    const settings = await store.getSettings();
    const approver = can(req.user, "approve_quotations");
    const full = await store.quotations.update(saved.id, {
      version: req.body?.version,
      user: req.user,
      refresh: true,
      action: "refreshed",
      summary: "Repriced with the current price list",
      statusFor: (pricing, current) =>
        current.status === "sent" && !approver && needsApproval(pricing, settings) ? "pending_review" : current.status,
    });
    res.json(editorQuote(full));
  });

  app.get("/api/quotations/:id/revisions", async (req, res) => {
    const q = await getQuotation(req, res);
    if (q) res.json(await store.quotations.revisions(q.id));
  });

  app.get("/api/quotations/:id/revisions/:revision", async (req, res) => {
    const q = await getQuotation(req, res);
    if (!q) return;
    const snap = await store.quotations.revision(q.id, Number(req.params.revision));
    if (!snap) return res.status(404).json({ error: "Revision not found" });
    res.json(editorQuote(snap));
  });

  app.post("/api/quotations/:id/pdf", async (req, res) => {
    const q = await getQuotation(req, res);
    if (!q) return;
    await store.audit(req.user, "quotation.pdf", "quotation", q.id, { number: q.number, version: q.version, total: q.total });
    res.json({ ok: true });
  });

  app.delete("/api/quotations/:id", requirePermission("delete_quotations"), async (req, res) => {
    await store.quotations.remove(req.params.id, req.user);
    res.json({ deleted: true });
  });

  app.post("/api/quotations/:id/restore", requirePermission("delete_quotations"), async (req, res) => {
    await store.quotations.restore(req.params.id, req.user);
    res.json({ restored: true });
  });

  // ---------- Staff and audit ----------

  app.get("/api/staff", requirePermission("manage_staff"), async (_req, res) => {
    res.json({ users: await store.auth.listUsers(), roles: ROLES, permissions: PERMISSIONS });
  });
  app.post("/api/staff", requirePermission("manage_staff"), async (req, res) => {
    res.status(201).json(await store.auth.createUser(req.body ?? {}, req.user));
  });
  app.put("/api/staff/:id", requirePermission("manage_staff"), async (req, res) => {
    res.json(await store.auth.updateUser(req.params.id, req.body ?? {}, req.user));
  });
  app.get("/api/audit", requirePermission("manage_staff"), async (req, res) => {
    res.json(await store.auditLog({ limit: Number(req.query.limit) || 200 }));
  });

  // ---------- Manager dashboard (chats and settings) ----------

  const admin = express.Router();

  admin.get("/overview", async (_req, res) => {
    const [convs, quotes, settings] = await Promise.all([store.listConversations(), store.quotations.list(), store.getSettings()]);
    const issued = quotes.filter((q) => q.status !== "draft");
    const sum = (list) => Math.round(list.reduce((s, q) => s + q.total, 0) * 100) / 100;
    const by = (status) => quotes.filter((q) => q.status === status);
    res.json({
      currency: settings.currency,
      conversations: convs.length,
      activeToday: convs.filter((c) => Date.now() - Date.parse(c.updatedAt) < 86_400_000).length,
      needsHuman: convs.filter((c) => c.status === "needs_human").length,
      quotes: issued.length,
      drafts: by("draft").length,
      pendingReview: by("pending_review").length,
      pipelineValue: sum([...by("sent"), ...by("pending_review")]),
      acceptedValue: sum(by("accepted")),
      conversionRate: issued.length ? by("accepted").length / issued.length : 0,
    });
  });

  admin.get("/conversations", requirePermission("supervise_chats"), async (_req, res) => {
    const [convs, quotes] = await Promise.all([store.listConversations(), store.quotations.list()]);
    res.json(convs.map((c) => adminConversationSummary(c, quotes.filter((q) => q.conversationId === c.id))));
  });

  const getConv = async (req, res) => {
    const conv = await store.getConversation(req.params.id);
    if (!conv) res.status(404).json({ error: "Conversation not found" });
    return conv;
  };

  admin.get("/conversations/:id", requirePermission("supervise_chats"), async (req, res) => {
    const conv = await getConv(req, res);
    if (!conv) return;
    const list = await store.quotations.list({ conversationId: conv.id });
    const quotes = (await Promise.all(list.map((q) => store.quotations.get(q.id)))).filter(Boolean).map(editorQuote);
    res.json({ ...adminConversationSummary(conv, list), transcript: conv.transcript, quotes });
  });

  admin.patch("/conversations/:id", requirePermission("supervise_chats"), async (req, res) => {
    const conv = await getConv(req, res);
    if (!conv) return;
    const { aiPaused, status } = req.body ?? {};
    if (typeof aiPaused === "boolean") conv.aiPaused = aiPaused;
    if (["active", "needs_human", "closed"].includes(status)) conv.status = status;
    await store.touch(conv);
    res.json(adminConversationSummary(conv, await store.quotations.list({ conversationId: conv.id })));
  });

  admin.post("/conversations/:id/messages", requirePermission("supervise_chats"), async (req, res) => {
    const conv = await getConv(req, res);
    if (!conv) return;
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "Message is empty" });
    const author = req.user.name;
    conv.transcript.push({ role: "staff", author, text, at: now() });
    (conv.pending ??= []).push(`<staff_message from="${author}">${text}</staff_message>`);
    await store.touch(conv);
    res.json({ ok: true });
  });

  const numericSettings = ["taxRatePercent", "maxDiscountPercent", "autoApproveLimit", "quoteValidDays"];
  const stringSettings = [
    "companyName", "currency", "agentInstructions", "companyTagline", "companyAddress", "companyPhone",
    "companyEmail", "companyWebsite", "quotePrefix", "quoteSubtitle", "quoteSignatory", "quoteSignatoryTitle",
    "quoteTerms",
  ];
  admin.get("/settings", async (_req, res) => res.json(await store.getSettings()));
  admin.put("/settings", requirePermission("manage_pricing"), async (req, res) => {
    const patch = {};
    for (const k of numericSettings) {
      if (req.body?.[k] === undefined) continue;
      const v = Number(req.body[k]);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a number ≥ 0` });
      if (k.endsWith("Percent") && v > 100) return res.status(400).json({ error: `${k} must be at most 100` });
      patch[k] = v;
    }
    for (const k of stringSettings) {
      if (typeof req.body?.[k] === "string") patch[k] = req.body[k].slice(0, 5000);
    }
    res.json(await store.updateSettings(patch, req.user));
  });

  app.use("/api/admin", admin);

  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  // Errors: validation problems are the caller's (400), conflicts 409, the rest 500.
  app.use((err, _req, res, _next) => {
    if (err instanceof PricingError) return res.status(400).json({ error: err.message });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.current && { current: err.current }) });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}
