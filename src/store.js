// The shared store: settings, assistant chats, the audit log and live change
// events, plus the catalogue, quotations and staff accounts. Everything lives
// in the database (see db.js) so every employee and every server instance
// sees the same data.
import fs from "node:fs";
import crypto from "node:crypto";
import { defaultSettings } from "./defaults.js";
import { createCatalog, productFromRow } from "./catalog.js";
import { createQuotations } from "./quotations.js";
import { createAuth } from "./auth.js";
import { variablesFromRates } from "./variables.js";

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

const convFromRow = (r) => ({
  id: r.id,
  token: r.token,
  staffUserId: r.staff_user_id,
  status: r.status,
  aiPaused: r.ai_paused,
  provider: r.provider ?? undefined,
  system: r.system_prompt ?? undefined,
  customer: r.customer ?? {},
  job: r.job,
  draftQuotationId: r.draft_quotation_id,
  messages: r.messages ?? [],
  transcript: r.transcript ?? [],
  pending: r.pending ?? [],
  escalation: r.escalation,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/**
 * @param {object} db  From openDatabase().
 * @param {{legacyFile?: string}} [options]  JSON data file from before the database, imported once.
 */
export async function createStore(db, { legacyFile } = {}) {
  const listeners = new Set();
  await db.onEvent((payload) => {
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    for (const fn of listeners) fn(event);
  });
  const emit = (event) => db.notify({ ...event, at: new Date().toISOString() }).catch((e) => console.error("notify failed", e));

  const audit = (user, action, entityType, entityId, details = {}) =>
    db.query(
      "INSERT INTO audit_log (user_id, user_name, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5, $6)",
      [user?.id ?? null, user?.name ?? "System", action, entityType, entityId ?? null, JSON.stringify(details)],
    );

  const getSettings = async () => {
    const { rows } = await db.query("SELECT key, value FROM settings");
    // Keys starting with "_" are internal markers, not settings.
    return { ...defaultSettings, ...Object.fromEntries(rows.filter((r) => !r.key.startsWith("_")).map((r) => [r.key, r.value])) };
  };

  const catalog = createCatalog({ db, emit, audit });
  const quotations = createQuotations({ db, emit, audit, getSettings, getPricingData: () => catalog.getPricingData() });
  const auth = createAuth({ db, emit, audit });

  const store = {
    db,
    emit,
    audit,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getSettings,
    async updateSettings(patch, user) {
      const before = await getSettings();
      await db.transaction(async (tx) => {
        for (const [k, v] of Object.entries(patch)) {
          await tx.query(
            `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [k, JSON.stringify(v), user?.name ?? null],
          );
        }
      });
      const changes = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => before[k] !== v).map(([k, v]) => [k, { from: before[k], to: v }]),
      );
      if (Object.keys(changes).length) await audit(user, "settings.update", "settings", null, changes);
      await emit({ type: "settings" });
      return getSettings();
    },

    /** Rate card, extras and settings as of now, for pricing a new job. */
    async getPricingContext() {
      const [data, settings] = await Promise.all([catalog.getPricingData(), getSettings()]);
      return { ...data, settings };
    },

    // ---------- Assistant chats ----------
    async createConversation(staffUserId) {
      const { rows } = await db.query(
        "INSERT INTO conversations (id, token, staff_user_id) VALUES ($1, $2, $3) RETURNING *",
        [`conv_${crypto.randomBytes(6).toString("hex")}`, crypto.randomBytes(24).toString("hex"), staffUserId ?? null],
      );
      return convFromRow(rows[0]);
    },
    async getConversation(id) {
      const { rows } = await db.query("SELECT * FROM conversations WHERE id = $1", [id]);
      return rows[0] ? convFromRow(rows[0]) : null;
    },
    async listConversations() {
      const { rows } = await db.query("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 500");
      return rows.map(convFromRow);
    },
    /** Saves the whole chat (history, transcript, job, customer). */
    async touch(conv) {
      conv.updatedAt = new Date().toISOString();
      await db.query(
        `UPDATE conversations SET status = $2, ai_paused = $3, provider = $4, system_prompt = $5, customer = $6, job = $7,
           draft_quotation_id = $8, messages = $9, transcript = $10, pending = $11, escalation = $12, updated_at = now()
         WHERE id = $1`,
        [conv.id, conv.status, !!conv.aiPaused, conv.provider ?? null, conv.system ?? null, JSON.stringify(conv.customer ?? {}),
          JSON.stringify(conv.job ?? null), conv.draftQuotationId ?? null, JSON.stringify(conv.messages), JSON.stringify(conv.transcript),
          JSON.stringify(conv.pending ?? []), JSON.stringify(conv.escalation ?? null)],
      );
      await emit({ type: "conversation", id: conv.id });
    },
    /** Deletes a chat. Its quotations stay saved (detached from the chat). */
    async deleteConversation(id) {
      await db.query("DELETE FROM conversations WHERE id = $1", [id]);
    },

    async auditLog({ limit = 200 } = {}) {
      const { rows } = await db.query("SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1", [Math.min(limit, 1000)]);
      return rows.map((r) => ({
        at: iso(r.at), user: r.user_name, action: r.action, entityType: r.entity_type, entityId: r.entity_id, details: r.details,
      }));
    },

    ...catalog,
    quotations,
    auth,
  };

  await catalog.seed();
  if (legacyFile) await importLegacyFile(store, legacyFile);
  await applyRebrand(store);
  return store;
}

/**
 * One-off rename from Profile Brick & Tile to Bulkbrick Supplies. Only settings
 * still holding the old defaults change; anything staff typed in themselves stays.
 */
async function applyRebrand(store) {
  const { rows } = await store.db.query("SELECT 1 FROM settings WHERE key = '_rebrandBulkbrick'");
  if (rows.length) return;
  const old = { companyName: "Profile Brick & Tile", quotePrefix: "PB&T" };
  const current = await store.getSettings();
  const patch = { _rebrandBulkbrick: new Date().toISOString() };
  for (const [k, v] of Object.entries(old)) if (current[k] === v) patch[k] = defaultSettings[k];
  await store.updateSettings(patch, { name: "Rebrand to Bulkbrick Supplies" });
}

/**
 * One-off import of the JSON data file used before the database: settings,
 * the edited rate card, accessories and saved quotes. Runs only once, while
 * the database has no quotations and no recorded import.
 */
async function importLegacyFile(store, file) {
  if (!fs.existsSync(file)) return;
  const { db } = store;
  const done = await db.query("SELECT 1 FROM settings WHERE key = '_legacyImport'");
  if (done.rows.length) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Couldn't read ${file} for import:`, err.message);
    return;
  }
  const settingsPatch = { ...(data.settings ?? {}), _legacyImport: new Date().toISOString() };
  // A placeholder name from an early version.
  if (settingsPatch.companyName === "Acme Brick & Paving") delete settingsPatch.companyName;
  await store.updateSettings(settingsPatch, { name: "Import from data file" });

  const rates = data.rates;
  if (rates?.products && rates.delivery?.brackets) {
    // Prices edited in the old rate card win over the seed prices.
    for (const [key, p] of Object.entries(rates.products)) {
      const { rows } = await db.query("SELECT * FROM products WHERE id = $1", [key]);
      if (rows.length) {
        const cur = productFromRow(rows[0]);
        if (cur.unitPrice !== p.unitPrice || cur.labourRate !== p.labour?.rate) {
          await db.query("UPDATE products SET unit_price = $2, labour_rate = $3 WHERE id = $1", [key, p.unitPrice, p.labour?.rate ?? null]);
          await db.query(
            "INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by_name) VALUES ($1, 'unit_price', $2, $3, 'Import from data file')",
            [key, cur.unitPrice, p.unitPrice],
          );
        }
      }
    }
    for (const v of variablesFromRates(rates)) {
      await db.query(
        `INSERT INTO pricing_variables (id, kind, name, data_type, unit, value, fields, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, fields = EXCLUDED.fields, name = EXCLUDED.name`,
        [v.id, v.kind, v.name, v.data_type ?? "number", v.unit ?? "", v.value ?? null, JSON.stringify(v.fields), v.sort_order],
      );
    }
  }
  for (const c of data.catalog ?? []) {
    await db.query("UPDATE products SET unit_price = $2, active = $3 WHERE sku = $1", [c.sku, c.unitPrice, c.active !== false]);
  }

  // Quotes are imported as they were, priced with the rate card of the time.
  const snapshotRates = await store.getPricingContext();
  let maxSeq = 0;
  for (const old of Object.values(data.quotes ?? {})) {
    const seq = Number(String(old.number ?? "").split("-").at(-1)) || 0;
    maxSeq = Math.max(maxSeq, seq);
    const snapshot = {
      takenAt: old.createdAt, rates: rates ?? snapshotRates.rates, catalog: data.catalog ?? [],
      settings: { currency: old.currency, taxRatePercent: old.taxRatePercent, maxDiscountPercent: data.settings?.maxDiscountPercent ?? 10, autoApproveLimit: data.settings?.autoApproveLimit ?? 50000 },
      imported: true,
    };
    await db.query(
      `INSERT INTO quotations (id, number, status, customer, project_name, site_address, project_summary, notes, staff_note, job,
         extras, pricing_snapshot, details, currency, subtotal, discount_percent, discount, tax_rate_percent, tax, total, valid_until,
         created_by_name, updated_by_name, created_at, updated_at, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'Assistant (imported)',
         'Assistant (imported)', $22, $23, $24) ON CONFLICT (id) DO NOTHING`,
      [old.id, old.number ?? old.id, old.status, JSON.stringify(old.customer ?? {}), old.projectName ?? "", old.siteAddress ?? "",
        old.projectSummary ?? "", old.notes ?? "", old.staffNote ?? "", JSON.stringify(old.job ?? null),
        JSON.stringify((old.lines ?? []).filter((l) => l.sku).map((l) => ({ sku: l.sku, quantity: l.quantity }))),
        JSON.stringify(snapshot), JSON.stringify(old.details ?? null), old.currency, old.subtotal, old.discountPercent ?? 0,
        old.discount ?? 0, old.taxRatePercent, old.tax, old.total, old.validUntil ?? null, old.createdAt, old.updatedAt ?? old.createdAt,
        old.acceptedAt ?? null],
    );
    for (const [i, l] of (old.lines ?? []).entries()) {
      await db.query(
        `INSERT INTO quotation_line_items (quotation_id, position, sku, name, detail, unit, quantity, unit_price, list_unit_price,
           line_total, volume_discount_percent, material) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING`,
        [old.id, i, l.sku ?? null, l.name, l.detail ?? "", l.unit ?? "", l.quantity, l.unitPrice, l.listUnitPrice ?? null, l.lineTotal,
          l.volumeDiscountPercent ?? 0, !!l.material],
      );
    }
  }
  if (maxSeq) await db.query("SELECT setval('quotation_number_seq', greatest($1, (SELECT last_value FROM quotation_number_seq)))", [maxSeq]);
  console.log(`Imported settings, rate card and ${Object.keys(data.quotes ?? {}).length} quotes from ${file}.`);
}
