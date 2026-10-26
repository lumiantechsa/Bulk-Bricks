// Pricing variables: every rate the calculation engine uses, stored as rows so
// staff can edit them. Each row has a kind; the kind fixes which fields it has,
// how they're validated and where the engine reads them. Staff can add rows of
// the engine kinds (a new vehicle, delivery bracket or colour) and custom
// adjustments, which use one of the fixed rules in ADJUSTMENT_RULES. Nothing
// here evaluates formulas or code.
import { ADJUSTMENT_RULES, PricingError } from "./pricing.js";

const currency = (key, label) => ({ key, label, type: "currency" });
const num = (key, label, extra = {}) => ({ key, label, type: "number", ...extra });
const bool = (key, label) => ({ key, label, type: "boolean" });

export const VARIABLE_KINDS = {
  rate: { label: "Rate", group: "General rates", fields: [] },
  delivery_bracket: {
    label: "Delivery bracket", group: "Delivery",
    fields: [num("upToKm", "Up to (km)", { min: 1 }), currency("charge", "Charge per trip")],
  },
  vehicle: {
    label: "Vehicle", group: "Delivery",
    fields: [
      num("capacityKg", "Capacity (kg)", { min: 1 }), num("pallets", "Pallets per trip", { min: 1, integer: true }),
      currency("baseFee", "Base fee per trip"), num("distanceFactor", "Distance factor", { min: 0 }), bool("crane", "Crane truck"),
    ],
  },
  offloading: {
    label: "Offloading method", group: "Offloading & site",
    fields: [currency("perTrip", "Per trip"), currency("perPallet", "Per pallet"), bool("needsCrane", "Needs a crane truck")],
  },
  slope: { label: "Slope", group: "Labour & installation", fields: [num("factor", "Labour factor", { min: 0.1, max: 10 })] },
  ground_prep: { label: "Ground preparation", group: "Labour & installation", fields: [currency("perM2", "Per m²")] },
  customer_discount: {
    label: "Customer discount", group: "Discounts",
    fields: [num("percent", "Discount %", { min: 0, max: 100, nullable: true }), currency("minMaterials", "Minimum materials value")],
  },
  colour: { label: "Colour surcharge", group: "Colours & finishes", fields: [currency("surcharge", "Surcharge per unit")] },
  finish: { label: "Finish surcharge", group: "Colours & finishes", fields: [currency("surcharge", "Surcharge per unit")] },
  wastage_option: { label: "Wastage option", group: "Wastage", fields: [num("percent", "Wastage %", { min: 0, max: 30 })] },
  adjustment: { label: "Custom adjustment", group: "Custom adjustments", fields: [] },
};

// Single values the engine reads, by their place in the rate card. These are
// fixed: they can be edited but not added, removed or switched off.
export const RATE_PATHS = {
  "pallets.fullPalletFee": { name: "Full pallet fee (strapping and wrapping)", unit: "per pallet", type: "currency", group: "Pallets & packaging" },
  "pallets.partialPalletFee": { name: "Partial pallet fee (breaking bulk)", unit: "per pallet", type: "currency", group: "Pallets & packaging" },
  "pallets.deposit": { name: "Pallet deposit", unit: "per pallet", type: "currency", group: "Pallets & packaging" },
  "pallets.returnCredit": { name: "Pallet return credit", unit: "per pallet", type: "currency", group: "Pallets & packaging" },
  "pallets.additionalPackingPerPallet": { name: "Additional packing", unit: "per pallet", type: "currency", group: "Pallets & packaging" },
  "delivery.beyond100PerKm": { name: "Cost per km beyond the last bracket", unit: "per km", type: "currency", group: "Delivery" },
  "delivery.maxDistanceKm": { name: "Maximum delivery distance", unit: "km", type: "number", group: "Delivery" },
  "difficultAccess.perTrip": { name: "Difficult access surcharge", unit: "per trip", type: "currency", group: "Offloading & site" },
  waitingPerHour: { name: "Truck waiting time", unit: "per hour", type: "currency", group: "Offloading & site" },
  "difficultAccess.labourFactor": { name: "Difficult access labour factor", unit: "×", type: "number", group: "Labour & installation" },
  minimumLabourCharge: { name: "Minimum labour charge", unit: "per job", type: "currency", group: "Labour & installation" },
  "jointMm.wall": { name: "Mortar joint for walls (coverage estimate)", unit: "mm", type: "number", group: "General rates" },
  "jointMm.paving": { name: "Joint for paving (coverage estimate)", unit: "mm", type: "number", group: "General rates" },
};

export const DATA_TYPES = ["currency", "percent", "number"];

const slug = (s) =>
  String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "item";

const getPath = (obj, p) => p.split(".").reduce((o, k) => o?.[k], obj);
const setPath = (obj, p, v) => {
  const keys = p.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = v;
};

/** Rows for the seed rate card (defaults.js). */
export function variablesFromRates(rates) {
  const rows = [];
  let order = 0;
  const add = (kind, key, name, fields, extra = {}) =>
    rows.push({ id: `${kind}.${key}`, kind, name, fields, sort_order: order++, ...extra });
  for (const [p, def] of Object.entries(RATE_PATHS)) {
    add("rate", p, def.name, {}, { value: getPath(rates, p), unit: def.unit, data_type: def.type });
  }
  rates.delivery.brackets.forEach((b) => add("delivery_bracket", `${b.upToKm}km`, `Up to ${b.upToKm} km`, { upToKm: b.upToKm, charge: b.charge }));
  for (const [k, v] of Object.entries(rates.delivery.vehicles)) {
    const { name, ...fields } = v;
    add("vehicle", k, name, fields);
  }
  for (const [k, v] of Object.entries(rates.offloading)) {
    add("offloading", k, v.name, { perTrip: v.perTrip ?? 0, perPallet: v.perPallet ?? 0, needsCrane: !!v.needsCrane });
  }
  for (const [k, v] of Object.entries(rates.slope)) add("slope", k, v.name, { factor: v.factor });
  for (const [k, v] of Object.entries(rates.groundPrep)) add("ground_prep", k, v.name, { perM2: v.perM2 });
  for (const [k, v] of Object.entries(rates.discounts)) {
    add("customer_discount", k, v.name, { percent: v.percent, minMaterials: v.minMaterials ?? 0 });
  }
  for (const [k, v] of Object.entries(rates.colours)) add("colour", k, v.name, { surcharge: v.surcharge });
  for (const [k, v] of Object.entries(rates.finishes)) add("finish", k, v.name, { surcharge: v.surcharge });
  rates.wastageOptions.forEach((w) => add("wastage_option", String(w.percent), w.name, { percent: w.percent }));
  return rows;
}

/** The part of the rate card that comes from pricing variables (everything but products). */
export function ratesFromVariables(rows) {
  const rates = {
    colours: {}, finishes: {}, wastageOptions: [], jointMm: {}, pallets: {},
    delivery: { brackets: [], vehicles: {} }, offloading: {}, difficultAccess: {}, slope: {}, groundPrep: {},
    discounts: {}, adjustments: [],
  };
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  for (const r of sorted) {
    const key = r.id.slice(r.kind.length + 1);
    const f = r.fields ?? {};
    if (r.kind === "rate") {
      setPath(rates, key, Number(r.value));
      continue;
    }
    if (r.active === false) continue;
    switch (r.kind) {
      case "delivery_bracket": rates.delivery.brackets.push({ upToKm: f.upToKm, charge: f.charge }); break;
      case "vehicle": rates.delivery.vehicles[key] = { name: r.name, ...f }; break;
      case "offloading": rates.offloading[key] = { name: r.name, perTrip: f.perTrip, perPallet: f.perPallet, ...(f.needsCrane && { needsCrane: true }) }; break;
      case "slope": rates.slope[key] = { name: r.name, factor: f.factor }; break;
      case "ground_prep": rates.groundPrep[key] = { name: r.name, perM2: f.perM2 }; break;
      case "customer_discount":
        rates.discounts[key] = { name: r.name, percent: f.percent ?? null, ...(f.minMaterials ? { minMaterials: f.minMaterials } : {}) };
        break;
      case "colour": rates.colours[key] = { name: r.name, surcharge: f.surcharge }; break;
      case "finish": rates.finishes[key] = { name: r.name, surcharge: f.surcharge }; break;
      case "wastage_option": rates.wastageOptions.push({ name: r.name, percent: f.percent }); break;
      case "adjustment":
        rates.adjustments.push({
          id: key, name: r.name, rule: r.rule, value: Number(r.value), categories: r.categories ?? [],
          description: r.description ?? "", unit: r.unit ?? "", dataType: r.data_type,
        });
        break;
    }
  }
  rates.delivery.brackets.sort((a, b) => a.upToKm - b.upToKm);
  rates.wastageOptions.sort((a, b) => a.percent - b.percent);
  return rates;
}

const fail = (msg) => { throw new PricingError(msg); };

function checkField(def, v) {
  if (def.type === "boolean") return !!v;
  if (v === null || v === "" || v === undefined) {
    if (def.nullable) return null;
    fail(`${def.label} is required.`);
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) fail(`${def.label} must be a number.`);
  const min = def.min ?? (def.type === "currency" ? 0 : -Infinity);
  if (n < min) fail(`${def.label} must be at least ${min}.`);
  if (def.max !== undefined && n > def.max) fail(`${def.label} must be at most ${def.max}.`);
  if (def.integer && !Number.isInteger(n)) fail(`${def.label} must be a whole number.`);
  if (Math.abs(n) > 1e9) fail(`${def.label} is too large.`);
  return def.type === "currency" ? Math.round(n * 100) / 100 : n;
}

/**
 * Validates a variable from the editor. `existing` is the stored row when
 * updating. Returns the columns to write.
 */
export function validateVariable(input, existing, categoryKeys) {
  const kind = existing?.kind ?? input?.kind;
  const def = VARIABLE_KINDS[kind];
  if (!def) fail(`kind must be one of: ${Object.keys(VARIABLE_KINDS).filter((k) => k !== "rate").join(", ")}.`);
  if (!existing && kind === "rate") fail("Rates are fixed; edit the existing ones.");
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 120) fail("Name is required (up to 120 characters).");
  const out = {
    kind,
    name,
    description: String(input.description ?? existing?.description ?? "").slice(0, 500),
    active: kind === "rate" ? true : input.active === undefined ? existing?.active ?? true : !!input.active,
    fields: {},
    value: null,
    unit: String(input.unit ?? existing?.unit ?? "").slice(0, 30),
    data_type: existing?.data_type ?? "number",
    categories: [],
    rule: null,
  };
  if (kind === "rate") {
    const rp = RATE_PATHS[existing.id.slice(5)];
    out.value = checkField({ label: name, type: rp.type, min: 0 }, input.value ?? existing.value);
    out.data_type = rp.type;
    out.unit = rp.unit;
  } else if (kind === "adjustment") {
    out.data_type = input.data_type ?? existing?.data_type ?? "currency";
    if (!DATA_TYPES.includes(out.data_type)) fail(`Data type must be one of: ${DATA_TYPES.join(", ")}.`);
    out.rule = input.rule ?? existing?.rule;
    if (!ADJUSTMENT_RULES[out.rule]) fail(`Rule must be one of: ${Object.keys(ADJUSTMENT_RULES).join(", ")}.`);
    if (out.rule === "percent_of_materials" && out.data_type !== "percent") fail("A percentage rule needs the percent data type.");
    if (out.rule !== "percent_of_materials" && out.rule !== "info" && out.data_type === "percent") {
      fail("The percent data type only works with the percentage rule.");
    }
    out.value = checkField(
      { label: "Value", type: out.data_type === "currency" ? "currency" : "number", min: out.data_type === "percent" ? 0 : -1e6, max: out.data_type === "percent" ? 100 : undefined },
      input.value ?? existing?.value,
    );
    const cats = input.categories ?? existing?.categories ?? [];
    if (!Array.isArray(cats) || cats.some((c) => !categoryKeys.includes(c))) {
      fail(`Categories must be from: ${categoryKeys.join(", ")}.`);
    }
    out.categories = [...new Set(cats)];
  } else {
    const src = input.fields ?? {};
    for (const fd of def.fields) out.fields[fd.key] = checkField(fd, src[fd.key] ?? existing?.fields?.[fd.key]);
  }
  return out;
}

export const newVariableId = (kind, name, taken) => {
  const base = `${kind}.${slug(name)}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
};

/** Kinds that the engine needs at least one active row of. */
export const REQUIRED_KINDS = ["delivery_bracket", "vehicle", "offloading", "slope", "ground_prep", "customer_discount"];
