// Saved quotations. Each one keeps its inputs (job, extras, manual lines,
// price overrides), its priced lines and totals, and a snapshot of the rate
// card it was priced with, so later price changes never alter it. Edits are
// recalculated against that snapshot; "refresh using current prices" swaps it
// for the current rate card after showing the differences.
import crypto from "node:crypto";
import { calculateQuotation, PricingError } from "./pricing.js";
import { HttpError } from "./catalog.js";

export const QUOTATION_STATUSES = ["draft", "pending_review", "sent", "accepted", "rejected"];
const CUSTOMER_FIELDS = ["name", "email", "company", "phone", "address"];
const MAX_EXTRAS = 30;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/** What the quotation was priced with: the rate card, extras and the tax settings. */
export const makeSnapshot = ({ rates, catalog }, settings) => ({
  takenAt: new Date().toISOString(),
  rates,
  catalog,
  settings: {
    currency: settings.currency,
    taxRatePercent: settings.taxRatePercent,
    maxDiscountPercent: settings.maxDiscountPercent,
    autoApproveLimit: settings.autoApproveLimit,
  },
});

const RATE_TABLES = ["products", "colours", "finishes", "offloading", "slope", "groundPrep", "discounts"];

/**
 * The saved snapshot, plus anything the edited quotation now uses that the
 * snapshot doesn't have yet (a product added later), at its current price.
 * Prices already in the snapshot are never changed here.
 */
export function extendSnapshot(snapshot, current, input) {
  const rates = structuredClone(snapshot.rates);
  for (const t of RATE_TABLES) rates[t] = { ...current.rates[t], ...rates[t] };
  rates.delivery = { ...rates.delivery, vehicles: { ...current.rates.delivery.vehicles, ...rates.delivery.vehicles } };
  const have = new Set(snapshot.catalog.map((c) => c.sku));
  const used = new Set((input.extras ?? []).map((e) => e.sku));
  const catalog = [...snapshot.catalog, ...current.catalog.filter((c) => !have.has(c.sku) && used.has(c.sku))];
  // Keep only the products the quotation uses, so the snapshot doesn't grow
  // with the whole current catalogue.
  const usedKeys = new Set((input.job?.materials ?? []).map((m) => m.productKey));
  for (const key of Object.keys(rates.products)) {
    if (!snapshot.rates.products[key] && !usedKeys.has(key)) delete rates.products[key];
  }
  return { ...snapshot, rates, catalog };
}

const ctxOf = (snapshot) => ({ rates: snapshot.rates, catalog: snapshot.catalog, settings: snapshot.settings });

/** Cleans the editable fields of a quotation. */
export function cleanInput(input, saved = {}) {
  const pickStr = (v, fallback, max) => String(v ?? fallback ?? "").slice(0, max);
  const customer = {};
  const src = input.customer ?? saved.customer ?? {};
  for (const k of CUSTOMER_FIELDS) {
    const v = String(src[k] ?? "").trim().slice(0, 300);
    if (v) customer[k] = v;
  }
  const extras = input.extras ?? saved.extras ?? [];
  if (!Array.isArray(extras) || extras.length > MAX_EXTRAS) throw new PricingError(`A quotation can have at most ${MAX_EXTRAS} extras.`);
  const overrides = input.overrides ?? saved.overrides ?? {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new PricingError("overrides must be an object.");
  let validUntil = input.validUntil ?? saved.validUntil ?? null;
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new PricingError("validUntil must be a date (YYYY-MM-DD).");
  return {
    customer,
    projectName: pickStr(input.projectName, saved.projectName, 200),
    siteAddress: pickStr(input.siteAddress, saved.siteAddress, 300),
    projectSummary: pickStr(input.projectSummary, saved.projectSummary, 1000),
    notes: pickStr(input.notes, saved.notes, 4000),
    job: input.job ?? saved.job,
    extras: extras.map((e) => ({ sku: String(e?.sku ?? ""), quantity: e?.quantity })),
    customLines: input.customLines ?? saved.customLines ?? [],
    overrides,
    validUntil,
  };
}

const lineFromRow = (r) => ({
  code: r.code,
  sku: r.sku ?? undefined,
  name: r.name,
  detail: r.detail,
  unit: r.unit,
  quantity: num(r.quantity),
  unitPrice: num(r.unit_price),
  ...(r.list_unit_price !== null && { listUnitPrice: num(r.list_unit_price) }),
  lineTotal: num(r.line_total),
  volumeDiscountPercent: num(r.volume_discount_percent),
  material: r.material,
  ...(r.vat_exempt && { vatExempt: true }),
  ...(r.overridden && { overridden: true }),
});

const summaryFromRow = (r) => ({
  id: r.id,
  number: r.number,
  conversationId: r.conversation_id,
  status: r.status,
  customer: r.customer ?? {},
  projectName: r.project_name,
  siteAddress: r.site_address,
  projectSummary: r.project_summary,
  currency: r.currency,
  subtotal: num(r.subtotal),
  discountPercent: num(r.discount_percent),
  discount: num(r.discount),
  taxRatePercent: num(r.tax_rate_percent),
  tax: num(r.tax),
  total: num(r.total),
  validUntil: day(r.valid_until),
  version: r.version,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  updatedByName: r.updated_by_name,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  acceptedAt: iso(r.accepted_at),
  deletedAt: iso(r.deleted_at),
});

const fullFromRow = (r, lines) => ({
  ...summaryFromRow(r),
  notes: r.notes,
  staffNote: r.staff_note,
  job: r.job,
  extras: r.extras ?? [],
  customLines: r.custom_lines ?? [],
  overrides: r.overrides ?? {},
  details: r.details,
  lines,
  pricingSnapshot: r.pricing_snapshot,
  snapshotTakenAt: r.pricing_snapshot?.takenAt ?? null,
});

const QUOTE_COLS =
  "status, customer, project_name, site_address, project_summary, notes, job, extras, custom_lines, overrides, " +
  "pricing_snapshot, details, currency, subtotal, discount_percent, discount, tax_rate_percent, tax, total, valid_until";
const quoteValues = (q) => [
  q.status, JSON.stringify(q.customer), q.projectName, q.siteAddress, q.projectSummary, q.notes, JSON.stringify(q.job ?? null),
  JSON.stringify(q.extras), JSON.stringify(q.customLines), JSON.stringify(q.overrides), JSON.stringify(q.pricingSnapshot),
  JSON.stringify(q.details ?? null), q.currency, q.subtotal, q.discountPercent ?? 0, q.discount ?? 0, q.taxRatePercent, q.tax,
  q.total, q.validUntil,
];

/** Line-by-line differences between two pricings of the same quotation. */
export function diffPricing(before, after) {
  const key = (l, i) => l.code ?? `#${i}`;
  const a = new Map(before.lines.map((l, i) => [key(l, i), l]));
  const b = new Map(after.lines.map((l, i) => [key(l, i), l]));
  const changes = [];
  for (const [k, l] of a) {
    const n = b.get(k);
    if (!n) changes.push({ code: k, name: l.name, before: l, after: null });
    else if (n.unitPrice !== l.unitPrice || n.quantity !== l.quantity || n.lineTotal !== l.lineTotal || n.name !== l.name) {
      changes.push({ code: k, name: n.name, before: l, after: n });
    }
  }
  for (const [k, n] of b) if (!a.has(k)) changes.push({ code: k, name: n.name, before: null, after: n });
  return {
    changes,
    totals: Object.fromEntries(["subtotal", "tax", "total"].map((t) => [t, { before: before[t], after: after[t] }])),
  };
}

export function createQuotations({ db, emit, audit, getSettings, getPricingData }) {
  const writeLines = async (tx, id, lines) => {
    await tx.query("DELETE FROM quotation_line_items WHERE quotation_id = $1", [id]);
    for (const [i, l] of lines.entries()) {
      await tx.query(
        `INSERT INTO quotation_line_items (quotation_id, position, code, sku, name, detail, unit, quantity, unit_price,
           list_unit_price, line_total, volume_discount_percent, material, vat_exempt, overridden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [id, i, l.code ?? null, l.sku ?? null, l.name, l.detail ?? "", l.unit ?? "", l.quantity, l.unitPrice,
          l.listUnitPrice ?? null, l.lineTotal, l.volumeDiscountPercent ?? 0, !!l.material, !!l.vatExempt, !!l.overridden],
      );
    }
  };

  const addRevision = async (tx, id, action, summary, user) => {
    const row = (await tx.query("SELECT * FROM quotations WHERE id = $1", [id])).rows[0];
    const lines = (await tx.query("SELECT * FROM quotation_line_items WHERE quotation_id = $1 ORDER BY position", [id])).rows.map(lineFromRow);
    await tx.query(
      `INSERT INTO quotation_revisions (quotation_id, revision, action, summary, snapshot, changed_by, changed_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, row.version, action, summary, JSON.stringify(fullFromRow(row, lines)), user?.id ?? null, user?.name ?? ""],
    );
    return fullFromRow(row, lines);
  };

  /** Prices cleaned input against a snapshot. */
  const price = (input, snapshot) => {
    const { unusedOverrides, ...pricing } = calculateQuotation(input, ctxOf(snapshot));
    // Overrides for lines that no longer exist (e.g. a removed material) are dropped.
    const overrides = { ...input.overrides };
    for (const code of unusedOverrides) delete overrides[code];
    return { pricing, overrides };
  };

  const q = {
    /** Prices a new quotation with the current rate card. */
    async price(input, { snapshot } = {}) {
      const settings = await getSettings();
      const current = await getPricingData();
      const snap = snapshot ? extendSnapshot(snapshot, current, input) : makeSnapshot(current, settings);
      const clean = cleanInput(input);
      const { pricing, overrides } = price(clean, snap);
      return { input: { ...clean, overrides }, pricing, snapshot: snap };
    },

    async create({ input, status = "draft", conversationId = null, user, action = "created", summary = "" }) {
      if (!QUOTATION_STATUSES.includes(status)) throw new HttpError(400, "Invalid status");
      const settings = await getSettings();
      const { input: clean, pricing, snapshot } = await q.price(input);
      clean.validUntil ||= new Date(Date.now() + settings.quoteValidDays * 86_400_000).toISOString().slice(0, 10);
      const id = `Q-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
      const record = { ...clean, ...pricing, status, pricingSnapshot: snapshot };
      const full = await db.transaction(async (tx) => {
        const seq = (await tx.query("SELECT nextval('quotation_number_seq') AS n")).rows[0].n;
        const number = `${settings.quotePrefix || "Q"}-${new Date().getFullYear()}-${String(seq).padStart(4, "0")}`;
        await tx.query(
          `INSERT INTO quotations (id, number, conversation_id, ${QUOTE_COLS}, created_by, created_by_name, updated_by, updated_by_name)
           VALUES ($1, $2, $3, ${Array.from({ length: 20 }, (_, i) => `$${i + 4}`).join(", ")}, $24, $25, $24, $25)`,
          [id, number, conversationId, ...quoteValues(record), user?.id ?? null, user?.name ?? ""],
        );
        await writeLines(tx, id, pricing.lines);
        return addRevision(tx, id, action, summary, user);
      });
      await audit(user, "quotation.create", "quotation", id, { number: full.number, total: full.total, status });
      await emit({ type: "quotation", id, action: "created", version: full.version, by: user?.id ?? null });
      return full;
    },

    async get(id, { includeDeleted = false } = {}) {
      const { rows } = await db.query("SELECT * FROM quotations WHERE id = $1", [id]);
      const row = rows[0];
      if (!row || (row.deleted_at && !includeDeleted)) return null;
      const lines = (await db.query("SELECT * FROM quotation_line_items WHERE quotation_id = $1 ORDER BY position", [id])).rows.map(lineFromRow);
      return fullFromRow(row, lines);
    },

    async list({ search = "", status = "", deleted = false, conversationId = null, limit = 500 } = {}) {
      const where = [deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
      const params = [];
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (conversationId) {
        params.push(conversationId);
        where.push(`conversation_id = $${params.length}`);
      }
      if (search.trim()) {
        params.push(`%${search.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
        const p = `$${params.length}`;
        where.push(`(lower(number) LIKE ${p} OR lower(customer->>'name') LIKE ${p} OR lower(customer->>'company') LIKE ${p}
          OR lower(customer->>'email') LIKE ${p} OR lower(project_name) LIKE ${p} OR lower(created_by_name) LIKE ${p})`);
      }
      params.push(Math.min(Number(limit) || 500, 1000));
      const { rows } = await db.query(
        `SELECT id, number, conversation_id, status, customer, project_name, site_address, project_summary, currency, subtotal,
           discount_percent, discount, tax_rate_percent, tax, total, valid_until, version, created_by, created_by_name,
           updated_by_name, created_at, updated_at, accepted_at, deleted_at
         FROM quotations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(summaryFromRow);
    },

    /**
     * Saves an edit. `version` must match the stored one, so two people editing
     * at once can't overwrite each other: the second save gets a 409.
     * With `refresh`, the quotation is repriced with the current rate card.
     */
    async update(id, { input = {}, version, user, status, statusFor, action = "edited", summary = "", refresh = false, extra = {} }) {
      const saved = await q.get(id);
      if (!saved) throw new HttpError(404, "Quotation not found");
      if (!Number.isInteger(version)) throw new HttpError(400, "version is required");
      if (version !== saved.version) {
        throw new HttpError(409, `${saved.updatedByName || "Someone"} saved this quotation after you opened it. Reload it to see their changes before saving yours.`, {
          current: saved,
        });
      }
      const clean = cleanInput(input, saved);
      const current = await getPricingData();
      const snapshot = refresh
        ? makeSnapshot(current, await getSettings())
        : extendSnapshot(saved.pricingSnapshot, current, clean);
      const { pricing, overrides } = price(clean, snapshot);
      // statusFor lets the caller decide the status from the new totals (e.g. back to approval).
      const newStatus = statusFor ? statusFor(pricing, saved) : status ?? saved.status;
      const record = { ...clean, overrides, ...pricing, status: newStatus, pricingSnapshot: snapshot };
      const full = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE quotations SET (${QUOTE_COLS}) = (${Array.from({ length: 20 }, (_, i) => `$${i + 3}`).join(", ")}),
             version = version + 1, updated_by = $23, updated_by_name = $24, updated_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING id`,
          [id, version, ...quoteValues(record), user?.id ?? null, user?.name ?? ""],
        );
        if (!rows.length) return null;
        if (extra.staffNote !== undefined) await tx.query("UPDATE quotations SET staff_note = $2 WHERE id = $1", [id, extra.staffNote]);
        if (extra.conversationId !== undefined) await tx.query("UPDATE quotations SET conversation_id = $2 WHERE id = $1", [id, extra.conversationId]);
        await writeLines(tx, id, pricing.lines);
        return addRevision(tx, id, action, summary, user);
      });
      if (!full) {
        throw new HttpError(409, "Someone else saved this quotation at the same moment. Reload it to see their changes.", { current: await q.get(id) });
      }
      await audit(user, `quotation.${action}`, "quotation", id, {
        number: full.number, totalBefore: saved.total, totalAfter: full.total, ...(newStatus !== saved.status && { status: newStatus }),
        ...(refresh && { refreshedPrices: true }),
      });
      await emit({ type: "quotation", id, action, version: full.version, by: user?.id ?? null });
      return full;
    },

    /** Status-only change (approve, decline, accept) without repricing. */
    async setStatus(id, { status, version, user, staffNote }) {
      if (!QUOTATION_STATUSES.includes(status)) {
        throw new HttpError(400, `status must be one of ${QUOTATION_STATUSES.join(", ")}`);
      }
      const saved = await q.get(id);
      if (!saved) throw new HttpError(404, "Quotation not found");
      const expected = Number.isInteger(version) ? version : saved.version;
      const full = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE quotations SET status = $3, staff_note = coalesce($4, staff_note),
             accepted_at = CASE WHEN $3 = 'accepted' THEN now() ELSE accepted_at END,
             version = version + 1, updated_by = $5, updated_by_name = $6, updated_at = now()
           WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING id`,
          [id, expected, status, typeof staffNote === "string" ? staffNote : null, user?.id ?? null, user?.name ?? ""],
        );
        if (!rows.length) return null;
        return addRevision(tx, id, `status:${status}`, staffNote ? `Note: ${staffNote}` : "", user);
      });
      if (!full) throw new HttpError(409, "This quotation changed while you were looking at it. Reload and try again.", { current: await q.get(id) });
      await audit(user, "quotation.status", "quotation", id, { number: full.number, from: saved.status, to: status, staffNote });
      await emit({ type: "quotation", id, action: "status", version: full.version, by: user?.id ?? null });
      return full;
    },

    async remove(id, user) {
      const { rows } = await db.query(
        "UPDATE quotations SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING number",
        [id, user?.id ?? null],
      );
      if (!rows.length) throw new HttpError(404, "Quotation not found");
      await audit(user, "quotation.delete", "quotation", id, { number: rows[0].number });
      await emit({ type: "quotation", id, action: "deleted", by: user?.id ?? null });
    },

    async restore(id, user) {
      const { rows } = await db.query(
        "UPDATE quotations SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING number",
        [id],
      );
      if (!rows.length) throw new HttpError(404, "Deleted quotation not found");
      await audit(user, "quotation.restore", "quotation", id, { number: rows[0].number });
      await emit({ type: "quotation", id, action: "restored", by: user?.id ?? null });
    },

    async revisions(id) {
      const { rows } = await db.query(
        `SELECT revision, action, summary, changed_by_name, created_at, snapshot->'total' AS total
         FROM quotation_revisions WHERE quotation_id = $1 ORDER BY revision DESC`,
        [id],
      );
      return rows.map((r) => ({
        revision: r.revision, action: r.action, summary: r.summary, changedBy: r.changed_by_name,
        at: iso(r.created_at), total: num(r.total),
      }));
    },

    async revision(id, revision) {
      const { rows } = await db.query("SELECT snapshot FROM quotation_revisions WHERE quotation_id = $1 AND revision = $2", [id, revision]);
      return rows[0]?.snapshot ?? null;
    },

    /** What would change if the quotation were repriced with today's prices. */
    async compareWithCurrent(id) {
      const saved = await q.get(id);
      if (!saved) throw new HttpError(404, "Quotation not found");
      const snapshot = makeSnapshot(await getPricingData(), await getSettings());
      const clean = cleanInput({}, saved);
      let after;
      try {
        after = price(clean, snapshot).pricing;
      } catch (err) {
        if (err instanceof PricingError) {
          throw new PricingError(`This quotation can't be priced with the current rate card: ${err.message}`);
        }
        throw err;
      }
      return { version: saved.version, snapshotTakenAt: saved.snapshotTakenAt, ...diffPricing(saved, after) };
    },
  };
  return q;
}
