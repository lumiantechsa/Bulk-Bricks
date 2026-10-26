// Product catalogue and pricing variables in the database. This is the single
// source of truth for prices: the quoting assistant, the job form and saved
// quotations all read the rate card built here.
import { PricingError } from "./pricing.js";
import { defaultCatalog, defaultRates } from "./defaults.js";
import {
  newVariableId, ratesFromVariables, REQUIRED_KINDS, validateVariable, variablesFromRates,
} from "./variables.js";

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const DEFAULT_CATEGORIES = [
  { key: "brick", name: "Bricks", kind: "material" },
  { key: "block", name: "Blocks", kind: "material" },
  { key: "paver", name: "Paving", kind: "material" },
  { key: "stone", name: "Natural stone", kind: "material" },
  { key: "flooring", name: "Flooring", kind: "material" },
  { key: "other", name: "Other products", kind: "material" },
  { key: "accessory", name: "Accessories", kind: "accessory" },
  { key: "service", name: "Services (delivery, labour, other)", kind: "service" },
];

export const MATERIAL_UNITS = ["brick", "block", "paver", "unit", "m²", "metre"];
export const VAT_TREATMENTS = ["standard", "zero_rated", "exempt"];
export const DELIVERY_REQUIREMENTS = ["none", "forklift", "crane"];

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** API shape of a product row. */
export const productFromRow = (r) => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  category: r.category_key,
  description: r.description,
  unit: r.unit,
  unitPrice: num(r.unit_price),
  vatTreatment: r.vat_treatment,
  lengthMm: num(r.length_mm),
  widthMm: num(r.width_mm),
  heightMm: num(r.height_mm),
  sizeVerified: r.size_verified,
  layout: r.layout,
  coveragePerM2: num(r.coverage_per_m2),
  unitsPerPallet: num(r.units_per_pallet),
  weightKg: num(r.weight_kg),
  defaultWastagePercent: num(r.default_wastage_percent),
  colour: r.colour,
  finish: r.finish,
  colourOptions: r.colour_options,
  finishOptions: r.finish_options,
  labourBasis: r.labour_basis,
  labourRate: num(r.labour_rate),
  deliveryRequirement: r.delivery_requirement,
  minQuantity: num(r.min_quantity),
  volumeTiers: r.volume_tiers ?? [],
  active: r.active,
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
});

/** The engine's view of a material product (see pricing.js). */
const engineMaterial = (p) => ({
  name: p.name,
  sku: p.sku,
  category: p.category,
  unit: p.unit,
  unitPrice: p.unitPrice,
  layout: p.layout,
  size: p.lengthMm && p.widthMm && p.heightMm ? { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm } : null,
  sizeVerified: p.sizeVerified,
  coveragePerM2: p.coveragePerM2,
  colour: p.colour,
  finish: p.finish,
  colourOptions: p.colourOptions?.length ? p.colourOptions : null,
  finishOptions: p.finishOptions?.length ? p.finishOptions : null,
  weightKg: p.weightKg,
  unitsPerPallet: p.unitsPerPallet,
  labour: p.labourRate === null ? null : { basis: p.labourBasis ?? "area", rate: p.labourRate },
  vatTreatment: p.vatTreatment,
  deliveryRequirement: p.deliveryRequirement,
  defaultWastagePercent: p.defaultWastagePercent,
});

/** The engine's view of an accessory or service (sold by SKU as an extra). */
const engineExtra = (p, kind) => ({
  sku: p.sku,
  name: p.name,
  description: p.description,
  unit: p.unit,
  unitPrice: p.unitPrice,
  minQuantity: p.minQuantity ?? undefined,
  volumeTiers: p.volumeTiers ?? [],
  active: p.active,
  category: p.category,
  kind,
  vatTreatment: p.vatTreatment,
});

const slug = (s) =>
  String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "product";

// ---------- Product validation ----------

const fail = (msg) => { throw new PricingError(msg); };
const text = (v, label, max, required = false) => {
  const s = String(v ?? "").trim();
  if (required && !s) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} is limited to ${max} characters.`);
  return s;
};
const number = (v, label, { min = 0, max = 1e9, required = false, integer = false } = {}) => {
  if (v === null || v === undefined || v === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${label} must be a number from ${min} to ${max}.`);
  if (integer && !Number.isInteger(n)) fail(`${label} must be a whole number.`);
  return n;
};
const list = (v, label) => {
  if (v === null || v === undefined || v === "") return null;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const out = arr.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > 20) fail(`${label}: at most 20 options.`);
  return out.length ? out : null;
};

/**
 * Checks a product from the editor (or the AI assistant) and returns the
 * missing required fields too, so the form can ask for them.
 * Which fields are required depends on the category's kind.
 */
export function checkProduct(input, categories, { partial = false, existing = null } = {}) {
  const merged = { ...(existing ?? {}), ...input };
  const category = categories.find((c) => c.key === merged.category);
  const missing = [];
  const need = (key, label) => {
    const v = merged[key];
    if (v === null || v === undefined || v === "") missing.push({ key, label });
  };
  need("name", "Product name");
  need("category", "Category");
  need("unit", "Unit of measurement");
  need("unitPrice", "Unit selling price");
  if (category?.kind === "material") {
    need("unitsPerPallet", "Units per pallet");
    need("weightKg", "Weight per unit (kg)");
  }
  if (partial) return { missing };
  if (missing.length) fail(`Missing: ${missing.map((m) => m.label).join(", ")}.`);
  if (!category) fail(`Category must be one of: ${categories.map((c) => c.key).join(", ")}.`);

  const material = category.kind === "material";
  const unit = text(merged.unit, "Unit", 20, true);
  if (material && !MATERIAL_UNITS.includes(unit)) fail(`Unit for ${category.name} must be one of: ${MATERIAL_UNITS.join(", ")}.`);
  const vat = merged.vatTreatment ?? "standard";
  if (!VAT_TREATMENTS.includes(vat)) fail(`VAT treatment must be one of: ${VAT_TREATMENTS.join(", ")}.`);
  const delivery = merged.deliveryRequirement ?? "none";
  if (!DELIVERY_REQUIREMENTS.includes(delivery)) fail(`Delivery requirement must be one of: ${DELIVERY_REQUIREMENTS.join(", ")}.`);
  const dims = ["lengthMm", "widthMm", "heightMm"].map((k, i) =>
    number(merged[k], ["Length", "Width", "Height"][i] + " (mm)", { min: 1, max: 5000 }));
  if (dims.some((d) => d !== null) && dims.some((d) => d === null)) fail("Enter all three dimensions, or none.");
  const layout = merged.layout || null;
  if (layout && !["wall", "paving"].includes(layout)) fail('Layout must be "wall" or "paving".');
  const labourBasis = merged.labourBasis || (material ? "area" : null);
  if (labourBasis && !["area", "quantity"].includes(labourBasis)) fail('Labour basis must be "area" or "quantity".');
  const tiers = merged.volumeTiers ?? [];
  if (!Array.isArray(tiers) || tiers.some((t) => !(t?.minQuantity > 0) || !(t.discountPercent >= 0 && t.discountPercent <= 100))) {
    fail("Volume tiers need a minimum quantity above 0 and a discount from 0 to 100%.");
  }
  const sku = text(merged.sku, "Product code / SKU", 40) || null;
  if (sku && !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(sku)) fail("SKU can use letters, digits, dots, dashes and slashes.");

  return {
    name: text(merged.name, "Product name", 120, true),
    sku,
    category: category.key,
    description: text(merged.description, "Description", 1000),
    unit,
    unitPrice: number(merged.unitPrice, "Unit price", { required: true, max: 1e7 }),
    vatTreatment: vat,
    lengthMm: dims[0],
    widthMm: dims[1],
    heightMm: dims[2],
    sizeVerified: !!merged.sizeVerified,
    layout: material ? layout : null,
    coveragePerM2: number(merged.coveragePerM2, "Coverage per m²", { min: 0.01, max: 10000 }),
    unitsPerPallet: material ? number(merged.unitsPerPallet, "Units per pallet", { min: 0.01, max: 100000, required: true }) : number(merged.unitsPerPallet, "Units per pallet", { min: 0.01, max: 100000 }),
    weightKg: material ? number(merged.weightKg, "Weight per unit (kg)", { max: 100000, required: true }) : number(merged.weightKg, "Weight per unit (kg)", { max: 100000 }),
    defaultWastagePercent: number(merged.defaultWastagePercent, "Wastage allowance", { max: 30 }),
    colour: text(merged.colour, "Colour", 60) || null,
    finish: text(merged.finish, "Finish", 60) || null,
    colourOptions: material ? list(merged.colourOptions, "Colour options") : null,
    finishOptions: material ? list(merged.finishOptions, "Finish options") : null,
    labourBasis: material ? labourBasis : null,
    labourRate: material ? number(merged.labourRate, "Installation labour rate", { max: 1e6 }) : null,
    deliveryRequirement: material ? delivery : "none",
    minQuantity: material ? null : number(merged.minQuantity, "Minimum quantity", { max: 1e6 }),
    volumeTiers: material ? [] : tiers.map((t) => ({ minQuantity: Number(t.minQuantity), discountPercent: Number(t.discountPercent) })),
    active: merged.active === undefined ? true : !!merged.active,
  };
}

const productColumns = (p) => [
  p.sku, p.name, p.category, p.description, p.unit, p.unitPrice, p.vatTreatment, p.lengthMm, p.widthMm, p.heightMm,
  p.sizeVerified, p.layout, p.coveragePerM2, p.unitsPerPallet, p.weightKg, p.defaultWastagePercent, p.colour, p.finish,
  p.colourOptions, p.finishOptions, p.labourBasis, p.labourRate, p.deliveryRequirement, p.minQuantity,
  JSON.stringify(p.volumeTiers ?? []), p.active,
];
const PRODUCT_COLS =
  "sku, name, category_key, description, unit, unit_price, vat_treatment, length_mm, width_mm, height_mm, " +
  "size_verified, layout, coverage_per_m2, units_per_pallet, weight_kg, default_wastage_percent, colour, finish, " +
  "colour_options, finish_options, labour_basis, labour_rate, delivery_requirement, min_quantity, volume_tiers, active";

const variableFromRow = (r) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  dataType: r.data_type,
  unit: r.unit,
  value: num(r.value),
  fields: r.fields ?? {},
  categories: r.categories ?? [],
  rule: r.rule,
  description: r.description,
  active: r.active,
  sortOrder: r.sort_order,
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
});

// Seed rows from defaults.js: the existing rate card and accessories.
function seedProducts() {
  const recategorise = { natural_stone_tiles: "stone", natural_stone_cladding: "stone", vinyl_flooring: "flooring" };
  const rows = Object.entries(defaultRates.products).map(([key, p], i) => ({
    id: key,
    sku: key.toUpperCase().replace(/_/g, "-"),
    name: p.name,
    category: recategorise[key] ?? p.category,
    description: "",
    unit: p.unit,
    unitPrice: p.unitPrice,
    vatTreatment: "standard",
    lengthMm: p.size?.lengthMm ?? null,
    widthMm: p.size?.widthMm ?? null,
    heightMm: p.size?.heightMm ?? null,
    sizeVerified: !!p.sizeVerified,
    layout: p.layout ?? null,
    coveragePerM2: p.coveragePerM2 ?? null,
    unitsPerPallet: p.unitsPerPallet,
    weightKg: p.weightKg,
    defaultWastagePercent: null,
    colour: p.colour ?? null,
    finish: p.finish ?? null,
    colourOptions: p.colourOptions ?? null,
    finishOptions: p.finishOptions ?? null,
    labourBasis: p.labour.basis,
    labourRate: p.labour.rate,
    deliveryRequirement: "none",
    minQuantity: null,
    volumeTiers: [],
    active: true,
    sortOrder: i,
  }));
  const offset = rows.length;
  defaultCatalog.forEach((c, i) =>
    rows.push({
      id: slug(c.sku), sku: c.sku, name: c.name, category: "accessory", description: c.description ?? "", unit: c.unit,
      unitPrice: c.unitPrice, vatTreatment: "standard", lengthMm: null, widthMm: null, heightMm: null, sizeVerified: false,
      layout: null, coveragePerM2: null, unitsPerPallet: null, weightKg: null, defaultWastagePercent: null, colour: null,
      finish: null, colourOptions: null, finishOptions: null, labourBasis: null, labourRate: null, deliveryRequirement: "none",
      minQuantity: c.minQuantity ?? null, volumeTiers: c.volumeTiers ?? [], active: c.active !== false, sortOrder: offset + i,
    }));
  return rows;
}

export function createCatalog({ db, emit, audit }) {
  const insertProduct = (q, id, p, user, sortOrder = 0) =>
    q.query(
      `INSERT INTO products (id, ${PRODUCT_COLS}, sort_order, created_by, updated_by)
       VALUES ($1, ${Array.from({ length: 26 }, (_, i) => `$${i + 2}`).join(", ")}, $28, $29, $29) RETURNING *`,
      [id, ...productColumns(p), sortOrder, user?.name ?? null],
    );

  const catalog = {
    async seed() {
      const cats = await db.query("SELECT count(*)::int AS n FROM product_categories");
      if (!cats.rows[0].n) {
        for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
          await db.query("INSERT INTO product_categories (key, name, kind, sort_order) VALUES ($1, $2, $3, $4)", [c.key, c.name, c.kind, i]);
        }
      }
      const prods = await db.query("SELECT count(*)::int AS n FROM products");
      if (!prods.rows[0].n) {
        await db.transaction(async (tx) => {
          for (const p of seedProducts()) {
            await insertProduct(tx, p.id, { ...p, sku: p.sku }, null, p.sortOrder);
            await tx.query(
              "INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by_name) VALUES ($1, 'unit_price', NULL, $2, 'Initial price list')",
              [p.id, p.unitPrice],
            );
          }
        });
      }
      const vars = await db.query("SELECT count(*)::int AS n FROM pricing_variables");
      if (!vars.rows[0].n) {
        await db.transaction(async (tx) => {
          for (const v of variablesFromRates(defaultRates)) {
            await tx.query(
              `INSERT INTO pricing_variables (id, kind, name, data_type, unit, value, fields, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [v.id, v.kind, v.name, v.data_type ?? "number", v.unit ?? "", v.value ?? null, JSON.stringify(v.fields), v.sort_order],
            );
          }
        });
      }
    },

    async listCategories() {
      return (await db.query("SELECT key, name, kind FROM product_categories ORDER BY sort_order, key")).rows;
    },

    async listProducts({ includeInactive = true } = {}) {
      const { rows } = await db.query(
        `SELECT p.* FROM products p JOIN product_categories c ON c.key = p.category_key
         ${includeInactive ? "" : "WHERE p.active"} ORDER BY c.sort_order, p.sort_order, p.name`,
      );
      return rows.map(productFromRow);
    },

    async getProduct(id) {
      const { rows } = await db.query("SELECT * FROM products WHERE id = $1", [id]);
      return rows[0] ? productFromRow(rows[0]) : null;
    },

    async createProduct(input, user) {
      const categories = await catalog.listCategories();
      const p = checkProduct(input, categories);
      const taken = new Set((await db.query("SELECT id, sku FROM products")).rows.flatMap((r) => [r.id, r.sku.toLowerCase()]));
      let id = slug(input.id || p.name);
      for (let i = 2; taken.has(id); i++) id = `${slug(input.id || p.name)}_${i}`;
      p.sku ||= id.toUpperCase().replace(/_/g, "-");
      if (taken.has(p.sku.toLowerCase())) throw new HttpError(409, `Another product already uses the code ${p.sku}.`);
      const row = await db.transaction(async (tx) => {
        const order = (await tx.query("SELECT coalesce(max(sort_order), 0) + 1 AS n FROM products")).rows[0].n;
        const { rows } = await insertProduct(tx, id, p, user, order);
        await tx.query(
          "INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1, 'unit_price', NULL, $2, $3, $4)",
          [id, p.unitPrice, user?.id ?? null, user?.name ?? ""],
        );
        return rows[0];
      });
      const product = productFromRow(row);
      await audit(user, "product.create", "product", id, { name: product.name, unitPrice: product.unitPrice, via: input.via ?? "form" });
      await emit({ type: "product", id, action: "created", by: user?.id ?? null });
      return product;
    },

    async updateProduct(id, input, version, user) {
      const existing = await catalog.getProduct(id);
      if (!existing) throw new HttpError(404, "Product not found");
      if (!Number.isInteger(version)) throw new HttpError(400, "version is required");
      const categories = await catalog.listCategories();
      const p = checkProduct(input, categories, { existing });
      if (p.sku && p.sku.toLowerCase() !== existing.sku.toLowerCase()) {
        const clash = await db.query("SELECT 1 FROM products WHERE lower(sku) = lower($1) AND id <> $2", [p.sku, id]);
        if (clash.rows.length) throw new HttpError(409, `Another product already uses the code ${p.sku}.`);
      }
      p.sku ||= existing.sku;
      const row = await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE products SET (${PRODUCT_COLS}) = (${Array.from({ length: 26 }, (_, i) => `$${i + 3}`).join(", ")}),
             version = version + 1, updated_by = $29, updated_at = now()
           WHERE id = $1 AND version = $2 RETURNING *`,
          [id, version, ...productColumns(p), user?.name ?? null],
        );
        if (!rows.length) return null;
        for (const [field, key] of [["unit_price", "unitPrice"], ["labour_rate", "labourRate"]]) {
          if (num(existing[key]) !== num(p[key])) {
            await tx.query(
              "INSERT INTO product_price_history (product_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1, $2, $3, $4, $5, $6)",
              [id, field, existing[key], p[key], user?.id ?? null, user?.name ?? ""],
            );
          }
        }
        return rows[0];
      });
      if (!row) {
        throw new HttpError(409, "Someone else changed this product after you opened it. Review their changes and try again.", {
          current: await catalog.getProduct(id),
        });
      }
      const product = productFromRow(row);
      const changes = Object.fromEntries(
        Object.keys(p).filter((k) => JSON.stringify(p[k] ?? null) !== JSON.stringify(existing[k] ?? null)).map((k) => [k, { from: existing[k], to: p[k] }]),
      );
      await audit(user, "product.update", "product", id, { name: product.name, changes });
      await emit({ type: "product", id, action: "updated", version: product.version, by: user?.id ?? null });
      return product;
    },

    async priceHistory(id) {
      const { rows } = await db.query(
        `SELECT field, old_value, new_value, changed_by_name, changed_at FROM product_price_history
         WHERE product_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 200`,
        [id],
      );
      return rows.map((r) => ({
        field: r.field, oldValue: num(r.old_value), newValue: num(r.new_value), changedBy: r.changed_by_name,
        changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : r.changed_at,
      }));
    },

    async listVariables() {
      const { rows } = await db.query("SELECT * FROM pricing_variables ORDER BY sort_order, id");
      return rows.map(variableFromRow);
    },

    async createVariable(input, user) {
      const categories = (await catalog.listCategories()).map((c) => c.key);
      const v = validateVariable(input ?? {}, null, categories);
      const taken = new Set((await db.query("SELECT id FROM pricing_variables")).rows.map((r) => r.id));
      const id = newVariableId(v.kind, v.name, taken);
      const { rows } = await db.query(
        `INSERT INTO pricing_variables (id, kind, name, data_type, unit, value, fields, categories, rule, description, active, sort_order, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (SELECT coalesce(max(sort_order), 0) + 1 FROM pricing_variables), $12)
         RETURNING *`,
        [id, v.kind, v.name, v.data_type, v.unit, v.value, JSON.stringify(v.fields), v.categories, v.rule, v.description, v.active, user?.name ?? null],
      );
      const variable = variableFromRow(rows[0]);
      await audit(user, "variable.create", "pricing_variable", id, { name: v.name, value: v.value, fields: v.fields, rule: v.rule });
      await emit({ type: "variable", id, action: "created" });
      return variable;
    },

    async updateVariable(id, input, version, user) {
      const { rows: found } = await db.query("SELECT * FROM pricing_variables WHERE id = $1", [id]);
      if (!found.length) throw new HttpError(404, "Pricing variable not found");
      if (!Number.isInteger(version)) throw new HttpError(400, "version is required");
      const existing = variableFromRow(found[0]);
      const categories = (await catalog.listCategories()).map((c) => c.key);
      const v = validateVariable(input ?? {}, { ...existing, data_type: existing.dataType }, categories);
      if (!v.active && REQUIRED_KINDS.includes(v.kind) && existing.active) {
        const others = await db.query("SELECT count(*)::int AS n FROM pricing_variables WHERE kind = $1 AND active AND id <> $2", [v.kind, id]);
        if (!others.rows[0].n) throw new PricingError("This is the last active one of its kind; the calculator needs at least one.");
      }
      const { rows } = await db.query(
        `UPDATE pricing_variables SET name = $3, data_type = $4, unit = $5, value = $6, fields = $7, categories = $8, rule = $9,
           description = $10, active = $11, version = version + 1, updated_by = $12, updated_at = now()
         WHERE id = $1 AND version = $2 RETURNING *`,
        [id, version, v.name, v.data_type, v.unit, v.value, JSON.stringify(v.fields), v.categories, v.rule, v.description, v.active, user?.name ?? null],
      );
      if (!rows.length) {
        throw new HttpError(409, "Someone else changed this variable after you opened it. Review their changes and try again.", {
          current: variableFromRow((await db.query("SELECT * FROM pricing_variables WHERE id = $1", [id])).rows[0]),
        });
      }
      const variable = variableFromRow(rows[0]);
      await audit(user, "variable.update", "pricing_variable", id, {
        name: v.name,
        from: { value: existing.value, fields: existing.fields, active: existing.active },
        to: { value: variable.value, fields: variable.fields, active: variable.active },
      });
      await emit({ type: "variable", id, action: "updated", version: variable.version });
      return variable;
    },

    /** The current approved rate card and extras, in the shape pricing.js expects. */
    async getPricingData() {
      const [categories, products, variables] = await Promise.all([
        catalog.listCategories(), catalog.listProducts({ includeInactive: false }), catalog.listVariables(),
      ]);
      const kindOf = Object.fromEntries(categories.map((c) => [c.key, c.kind]));
      const rates = ratesFromVariables(variables.map((v) => ({ ...v, sort_order: v.sortOrder, data_type: v.dataType })));
      rates.products = {};
      const extras = [];
      for (const p of products) {
        const kind = kindOf[p.category];
        if (kind === "material") rates.products[p.id] = engineMaterial(p);
        else extras.push(engineExtra(p, kind));
      }
      return { rates, catalog: extras, categories };
    },
  };
  return catalog;
}
