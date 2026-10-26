// Pure pricing logic. The agent never does arithmetic itself: every number a
// client sees comes from this file so totals are always consistent.

// Money is rounded to whole cents, half away from zero, after trimming float
// noise (1.005 is stored as 1.00499999…, which plain rounding gets wrong).
const roundHalf = (x) => Math.sign(x) * Math.round(Math.abs(x));
export const round2 = (n) => roundHalf(roundHalf(n * 1e6) / 1e4) / 100;
// Sums amounts in integer cents so long lists don't drift.
const sumMoney = (list) => list.reduce((s, n) => s + Math.round(n * 100), 0) / 100;
// Ceil that ignores float noise (100 * 1.05 is 105.00000000000001).
const ceilSafe = (n) => Math.ceil(Math.round(n * 1e6) / 1e6);

export class PricingError extends Error {}

function checkDiscount(discountPercent, settings) {
  if (typeof discountPercent !== "number" || discountPercent < 0 || discountPercent > 100) {
    throw new PricingError("discount_percent must be a number between 0 and 100.");
  }
  if (discountPercent > settings.maxDiscountPercent) {
    throw new PricingError(
      `Discounts above ${settings.maxDiscountPercent}% need a human. Use escalate_to_human instead.`,
    );
  }
}

/** Prices catalog line items (accessories), applying volume tiers. */
export function priceCatalogLines(lineItems, catalog) {
  const bySku = new Map(catalog.filter((p) => p.active !== false).map((p) => [p.sku, p]));
  return lineItems.map(({ sku, quantity }) => {
    const product = bySku.get(sku);
    if (!product) throw new PricingError(`Unknown or inactive SKU: ${sku}`);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PricingError(`Quantity for ${sku} must be a positive number.`);
    }
    const minQty = product.minQuantity ?? 1;
    if (quantity < minQty) {
      throw new PricingError(`${product.name} has a minimum quantity of ${minQty} ${product.unit}.`);
    }
    // Volume tiers: the highest tier whose minQuantity is met applies.
    const tier = (product.volumeTiers ?? [])
      .filter((t) => quantity >= t.minQuantity)
      .sort((a, b) => b.minQuantity - a.minQuantity)[0];
    const unitPrice = round2(product.unitPrice * (1 - (tier?.discountPercent ?? 0) / 100));
    return {
      code: `extra:${sku}`,
      sku,
      name: product.name,
      detail: product.description ?? "",
      unit: product.unit,
      quantity,
      listUnitPrice: product.unitPrice,
      unitPrice,
      volumeDiscountPercent: tier?.discountPercent ?? 0,
      lineTotal: round2(unitPrice * quantity),
      // Services aren't materials, so customer discounts don't apply to them.
      material: product.kind !== "service",
      ...(isVatExempt(product) && { vatExempt: true }),
    };
  });
}

const isVatExempt = (product) => !!product.vatTreatment && product.vatTreatment !== "standard";

/** Subtotal, discount, then tax (zero-rated and exempt lines carry no VAT). */
function totals(lines, settings, discountPercent) {
  const subtotal = sumMoney(lines.map((l) => l.lineTotal));
  const discount = round2(subtotal * (discountPercent / 100));
  const taxable = round2(subtotal - discount);
  const exempt = sumMoney(lines.filter((l) => l.vatExempt).map((l) => l.lineTotal));
  const taxBase = exempt ? round2(taxable - round2(exempt * (1 - discountPercent / 100))) : taxable;
  const tax = round2(taxBase * (settings.taxRatePercent / 100));
  return {
    currency: settings.currency,
    lines,
    subtotal,
    discountPercent,
    discount,
    taxRatePercent: settings.taxRatePercent,
    tax,
    total: round2(taxable + tax),
  };
}

/**
 * @param {Array<{sku: string, quantity: number}>} lineItems
 * @param {{catalog: Array, settings: object}} ctx
 * @param {number} [discountPercent]
 */
export function calculateQuote(lineItems, { catalog, settings }, discountPercent = 0) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new PricingError("At least one line item is required.");
  }
  checkDiscount(discountPercent, settings);
  return totals(priceCatalogLines(lineItems, catalog), settings, discountPercent);
}

// ---------- Brick, paver and other product jobs ----------

const pick = (table, key, field) => {
  const v = table?.[key];
  if (!v) throw new PricingError(`${field} must be one of: ${Object.keys(table ?? {}).join(", ")}.`);
  return v;
};

const positive = (v, field, max = Infinity) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) {
    throw new PricingError(`${field} must be a number above 0${max < Infinity ? ` and at most ${max}` : ""}.`);
  }
  return v;
};

const nonNegative = (v, field, max = Infinity) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
    throw new PricingError(`${field} must be a number from 0${max < Infinity ? ` to ${max}` : ""}.`);
  }
  return v;
};

const line = (name, unit, quantity, unitPrice, extra = {}) => ({
  name,
  unit,
  quantity,
  unitPrice: round2(unitPrice),
  volumeDiscountPercent: 0,
  lineTotal: round2(round2(unitPrice) * quantity),
  ...extra,
});

const PIECE_UNITS = new Set(["brick", "block", "paver", "unit"]);
const fmtSize = (s) => `${s.lengthMm} × ${s.widthMm} × ${s.heightMm} mm`;

/** Whether a product can be ordered by m² to cover (piece products need a coverage rate or a size). */
export const supportsArea = (product) =>
  product.unit === "m²" || (PIECE_UNITS.has(product.unit) && !!product.layout && !!(product.coveragePerM2 || product.size));

function deliveryCharge(km, delivery) {
  let from = 0;
  for (const b of delivery.brackets) {
    if (km <= b.upToKm) return { charge: b.charge, label: `${from}–${b.upToKm} km` };
    from = b.upToKm + 1;
  }
  const last = delivery.brackets.at(-1);
  return {
    charge: last.charge + (km - last.upToKm) * delivery.beyond100PerKm,
    label: `over ${last.upToKm} km (${km} km)`,
  };
}

// Fields that belong to each material; everything else on the job (delivery,
// pallets, labour, customer) is shared by all of its materials.
export const MATERIAL_FIELDS = [
  "productKey", "colour", "finish", "useCustomSize", "lengthMm", "widthMm", "heightMm",
  "quantityMode", "quantity", "wastagePercent",
];
export const JOB_FIELDS = [
  "deliveryDistanceKm", "otherProvince", "vehicle", "offloading", "difficultAccess", "waitingHours",
  "returnPallets", "additionalPacking", "includeLabour", "slope", "groundPrep", "customerType", "negotiatedPercent",
];
export const MAX_MATERIALS = 12;

/**
 * Brings a job into its stored shape: `materials` (one entry per product with
 * its own parameters) plus the shared job fields. A job with a single product
 * at the top level (the older shape) becomes a job with one material.
 */
export function normalizeJob(job) {
  if (!job || typeof job !== "object") throw new PricingError("Job details are missing.");
  const list = Array.isArray(job.materials) ? job.materials : job.productKey !== undefined ? [job] : [];
  if (!list.length) throw new PricingError("Add at least one material (product and quantity).");
  if (list.length > MAX_MATERIALS) throw new PricingError(`A job can have at most ${MAX_MATERIALS} materials.`);
  const materials = list.map((m) => Object.fromEntries(MATERIAL_FIELDS.map((k) => [k, m?.[k]])));
  return { materials, ...Object.fromEntries(JOB_FIELDS.map((k) => [k, job[k]])) };
}

const plural = (n, unit) => (unit === "m²" || n === 1 ? unit : `${unit}s`);

/** Quantities, weight, pallets and material lines for one material of a job. */
function priceMaterial(m, rates, label, code) {
  const product = pick(rates.products, m.productKey, `${label}productKey`);
  const notes = [];

  // Colour and finish: a surcharge only when the product offers a choice.
  const choice = (optionsKey, table, value, field) => {
    const allowed = product[optionsKey];
    if (!allowed) return null; // built into the SKU
    if (!allowed.includes(value)) {
      throw new PricingError(`${label}${field} for ${product.name} must be one of: ${allowed.join(", ")}.`);
    }
    return { key: value, ...table[value] };
  };
  const colour = choice("colourOptions", rates.colours, m.colour, "colour");
  const finish = choice("finishOptions", rates.finishes, m.finish, "finish");

  // Size: the product's own, or custom dimensions entered on the form.
  let unitSize = product.size;
  if (m.useCustomSize) {
    unitSize = {
      lengthMm: positive(m.lengthMm, `${label}lengthMm`, 2000),
      widthMm: positive(m.widthMm, `${label}widthMm`, 2000),
      heightMm: positive(m.heightMm, `${label}heightMm`, 1000),
    };
  } else if (product.size && !product.sizeVerified) {
    notes.push(`${product.name}: size ${fmtSize(product.size)} is a typical size; confirm it from the product information.`);
  }

  if (!["units", "area"].includes(m.quantityMode)) {
    throw new PricingError(`${label}quantityMode must be "units" or "area".`);
  }
  const quantity = positive(m.quantity, `${label}quantity`);
  const wastagePercent = nonNegative(m.wastagePercent, `${label}wastagePercent`, 30);
  const piece = PIECE_UNITS.has(product.unit);
  const areaMode = m.quantityMode === "area" || product.unit === "m²";
  if (areaMode && !supportsArea(product)) {
    throw new PricingError(`${product.name} is sold per ${product.unit}; enter the quantity in ${product.unit}s, not m².`);
  }

  // Coverage per m²: the published rate wins over an estimate from the size.
  let coveragePerM2 = null;
  let coverageSource = null;
  if (piece && product.layout && (product.coveragePerM2 || unitSize)) {
    if (product.coveragePerM2) {
      coveragePerM2 = product.coveragePerM2;
      coverageSource = "catalogue";
    } else {
      const joint = rates.jointMm[product.layout];
      const faceH = product.layout === "wall" ? unitSize.heightMm : unitSize.widthMm;
      coveragePerM2 = round2(1e6 / ((unitSize.lengthMm + joint) * (faceH + joint)));
      coverageSource = "estimated from size";
    }
  }

  // Quantities: pieces round up to whole units, m² and metres to 0.1.
  const roundUp = piece ? ceilSafe : (n) => ceilSafe(n * 10) / 10;
  let netQty;
  let areaM2 = null;
  if (product.unit === "m²") {
    netQty = roundUp(quantity);
    areaM2 = netQty;
  } else if (areaMode) {
    areaM2 = round2(quantity);
    netQty = roundUp(quantity * coveragePerM2);
  } else {
    netQty = roundUp(quantity);
    if (coveragePerM2) areaM2 = round2(netQty / coveragePerM2);
  }
  const totalQty = roundUp(netQty * (1 + wastagePercent / 100));
  const wastageQty = round2(totalQty - netQty);

  // Weight, scaled when a custom size differs from the catalogue size.
  const vol = (sz) => sz.lengthMm * sz.widthMm * sz.heightMm;
  const sizeRatio = m.useCustomSize && product.size ? vol(unitSize) / vol(product.size) : 1;
  const weightKg = Math.round(totalQty * product.weightKg * sizeRatio);

  // Pallets: every product has its own pallet size.
  const fullPallets = Math.floor(round2(totalQty / product.unitsPerPallet));
  const partialPallet = totalQty - fullPallets * product.unitsPerPallet > 1e-9;
  const pallets = fullPallets + (partialPallet ? 1 : 0);

  const lines = [];
  const described = [product.name, unitSize && m.useCustomSize ? fmtSize(unitSize) : null]
    .concat(colour ? [colour.name] : [], finish && finish.key !== "standard" ? [finish.name] : [])
    .filter(Boolean)
    .join(", ");
  lines.push(
    line(described, product.unit, totalQty, product.unitPrice, {
      code: `${code}:product`,
      material: true,
      ...(isVatExempt(product) && { vatExempt: true }),
      detail: [
        unitSize ? fmtSize(unitSize) : null,
        wastageQty ? `Includes ${wastagePercent}% wastage allowance (${wastageQty} ${plural(wastageQty, product.unit)})` : null,
      ].filter(Boolean).join(" · "),
    }),
  );
  if (colour?.surcharge) {
    lines.push(line(`Colour surcharge: ${colour.name}`, product.unit, totalQty, colour.surcharge, { code: `${code}:colour`, material: true, ...(isVatExempt(product) && { vatExempt: true }), detail: `Additional charge for the chosen colour (${product.name}).` }));
  }
  if (finish?.surcharge) {
    lines.push(line(`Finish surcharge: ${finish.name}`, product.unit, totalQty, finish.surcharge, { code: `${code}:finish`, material: true, ...(isVatExempt(product) && { vatExempt: true }), detail: `Additional charge for the chosen finish (${product.name}).` }));
  }

  return {
    product,
    lines,
    notes,
    details: {
      productKey: m.productKey,
      product: product.name,
      category: product.category,
      described,
      unit: product.unit,
      unitPrice: product.unitPrice,
      colour: colour?.name ?? product.colour ?? null,
      finish: finish?.name ?? product.finish ?? null,
      size: unitSize ? fmtSize(unitSize) : null,
      coveragePerM2,
      coverageSource,
      areaM2,
      netQty,
      wastagePercent,
      wastageQty,
      totalQty,
      unitsPerPallet: product.unitsPerPallet,
      fullPallets,
      partialPallet,
      pallets,
      weightKg,
    },
  };
}

/**
 * Turns the job form into priced lines plus the working (coverage, units,
 * pallets, weight, trips) so staff can see how the numbers were reached.
 * Each material is priced with its own parameters; pallets, delivery and
 * labour are worked out for the whole load.
 *
 * @param {object} job  Fields from the job form / set_job_details tool.
 * @param {object} rates  The rate card (see defaults.js).
 */
export function priceJob(rawJob, rates) {
  const job = normalizeJob(rawJob);
  const multi = job.materials.length > 1;
  const priced = job.materials.map((m, i) => priceMaterial(m, rates, multi ? `Material ${i + 1}: ` : "", `m${i}`));
  const notes = priced.flatMap((p) => p.notes);
  const mats = priced.map((p) => p.details);
  const sum = (key) => mats.reduce((s, d) => s + d[key], 0);
  const lines = priced.flatMap((p) => p.lines);

  const fullPallets = sum("fullPallets");
  const partialPallets = mats.filter((d) => d.partialPallet).length;
  const pallets = sum("pallets");
  const weightKg = sum("weightKg");
  const palletSizes = mats.map((d) => (multi ? `${d.product}: ${d.unitsPerPallet}` : d.unitsPerPallet)).join("; ");

  // Pallets and packaging.
  const p = rates.pallets;
  if (fullPallets && p.fullPalletFee) lines.push(line("Full pallet (strapping and wrapping)", "pallet", fullPallets, p.fullPalletFee, { code: "pallet:full", detail: `Pallets of ${palletSizes}.` }));
  if (partialPallets && p.partialPalletFee) lines.push(line("Partial pallet (breaking bulk)", "pallet", partialPallets, p.partialPalletFee, { code: "pallet:partial", detail: "Part pallet made up from bulk stock." }));
  if (p.deposit) lines.push(line("Pallet deposit", "pallet", pallets, p.deposit, { code: "pallet:deposit", detail: "Deposit on pallets supplied." }));
  if (job.returnPallets && p.returnCredit) lines.push(line("Pallet return credit", "pallet", pallets, -p.returnCredit, { code: "pallet:return", detail: "Credit for pallets returned by the customer." }));
  if (job.additionalPacking && p.additionalPackingPerPallet) {
    lines.push(line("Additional packing", "pallet", pallets, p.additionalPackingPerPallet, { code: "pallet:packing", detail: "Extra shrink wrap and edge protection." }));
  }

  // Delivery: distance bracket × vehicle, chosen by the weight and pallets of all materials.
  const km = nonNegative(job.deliveryDistanceKm, "deliveryDistanceKm (0 = customer collects)");
  const { delivery: d } = rates;
  let delivery = null;
  if (job.otherProvince) {
    throw new PricingError("Deliveries to another province are a custom quote. Use escalate_to_human.");
  }
  if (km > 0) {
    if (km > d.maxDistanceKm) {
      throw new PricingError(`Deliveries over ${d.maxDistanceKm} km are a custom quote. Use escalate_to_human.`);
    }
    const offload = pick(rates.offloading, job.offloading, "offloading");
    // Some products can only be offloaded by forklift or crane.
    for (const { product } of priced) {
      const need = product.deliveryRequirement;
      if (need === "crane" && !offload.needsCrane) {
        throw new PricingError(`${product.name} must be offloaded by crane: choose crane offloading.`);
      }
      if (need === "forklift" && !offload.needsCrane && !/forklift/i.test(offload.name)) {
        throw new PricingError(`${product.name} needs a forklift or crane to offload: choose forklift or crane offloading.`);
      }
    }
    if (job.vehicle !== "auto") {
      const v = pick(d.vehicles, job.vehicle, 'vehicle (or "auto")');
      if (offload.needsCrane && !v.crane) throw new PricingError(`${offload.name} needs a crane truck, not a ${v.name}.`);
    }
    const waitingHours = nonNegative(job.waitingHours ?? 0, "waitingHours", 24);
    const bracket = deliveryCharge(km, d);
    const options = Object.entries(d.vehicles)
      .filter(([key, v]) => (job.vehicle === "auto" ? !offload.needsCrane || v.crane : key === job.vehicle))
      .map(([key, v]) => {
        const trips = Math.max(1, Math.ceil(weightKg / v.capacityKg), Math.ceil(pallets / v.pallets));
        const perTrip = round2(v.baseFee + bracket.charge * v.distanceFactor);
        return { key, vehicle: v, trips, perTrip, cost: trips * perTrip };
      })
      .sort((a, b) => a.cost - b.cost);
    delivery = options[0];
    const tripWord = delivery.trips === 1 ? "trip" : "trips";
    lines.push(
      line(`Delivery: ${delivery.vehicle.name}, ${bracket.label} (${delivery.trips} ${tripWord})`, "trip", delivery.trips, delivery.perTrip, {
        code: "delivery",
        detail: `Delivery of materials to site, ${km} km away.`,
      }),
    );
    if (offload.perTrip) lines.push(line(offload.name, "trip", delivery.trips, offload.perTrip, { code: "offload", detail: "Offloading at site." }));
    if (offload.perPallet) lines.push(line(offload.name, "pallet", pallets, offload.perPallet, { code: "offload:pallet", detail: "Offloading at site by hand." }));
    if (job.difficultAccess) lines.push(line("Difficult site access", "trip", delivery.trips, rates.difficultAccess.perTrip, { code: "access", detail: "Surcharge for restricted access to the site." }));
    if (waitingHours) lines.push(line("Additional waiting time", "hour", waitingHours, rates.waitingPerHour, { code: "waiting", detail: "Truck waiting time on site." }));
    delivery = { ...delivery, bracket: bracket.label, km, offloading: offload.name };
  }

  // Labour (each product at its own rate) and ground preparation, with one
  // minimum charge for the whole job.
  if (job.includeLabour) {
    const slope = pick(rates.slope, job.slope, "slope");
    const prep = pick(rates.groundPrep, job.groundPrep, "groundPrep");
    const accessFactor = job.difficultAccess ? rates.difficultAccess.labourFactor : 1;
    const label = [slope.name.toLowerCase(), job.difficultAccess ? "difficult access" : null].filter(Boolean).join(", ");
    const labourDetail = { detail: "Professional installation, including bedding and compaction." };
    for (const { product } of priced) {
      if (!product.labour) {
        throw new PricingError(`${product.name} has no installation labour rate yet. Leave installation out, or ask a manager to add one under Pricing Management.`);
      }
    }
    const labourLines = priced.map(({ product, details: md }, i) => {
      const area = product.labour.basis === "area";
      const name = multi ? `Installation labour: ${md.product} (${label})` : `Installation labour (${label})`;
      return line(name, area ? "m²" : product.unit, area ? md.areaM2 : md.netQty, product.labour.rate * slope.factor * accessFactor, { ...labourDetail, code: `labour:m${i}` });
    });
    if (labourLines.reduce((s, l) => s + l.lineTotal, 0) < rates.minimumLabourCharge) {
      lines.push(line("Installation labour (minimum charge)", "job", 1, rates.minimumLabourCharge, { ...labourDetail, code: "labour:minimum" }));
    } else {
      lines.push(...labourLines);
    }
    // Ground preparation is for the area being laid, not the face of a wall.
    const prepArea = round2(priced.reduce((s, { product, details: md }) => s + (product.layout === "wall" ? 0 : md.areaM2 ?? 0), 0));
    if (prep.perM2 && prepArea) {
      lines.push(line(`Ground preparation: ${prep.name.toLowerCase()}`, "m²", prepArea, prep.perM2 * slope.factor, { code: "prep", detail: "Site preparation before laying." }));
    }
  }

  lines.push(...adjustmentLines(rates.adjustments, priced, delivery, pallets));

  return {
    lines,
    details: {
      materials: mats,
      fullPallets,
      partialPallets,
      pallets,
      weightKg,
      delivery: delivery
        ? { vehicle: delivery.vehicle.name, trips: delivery.trips, perTrip: delivery.perTrip, bracket: delivery.bracket, km, offloading: delivery.offloading }
        : null,
      labourIncluded: !!job.includeLabour,
      notes,
    },
  };
}

// How a staff-defined pricing adjustment is charged. Adjustments are data, not
// code: each one picks one of these fixed rules, a value and the product
// categories it applies to (none = all).
export const ADJUSTMENT_RULES = {
  per_unit: "Per unit of matching products",
  per_m2: "Per m² of matching products",
  percent_of_materials: "% of matching products' price",
  per_pallet: "Per pallet of matching products",
  per_trip: "Per delivery trip",
  per_quote: "Once per quotation",
  info: "Reference only (not charged)",
};

function adjustmentLines(adjustments, priced, delivery, pallets) {
  const out = [];
  for (const adj of adjustments ?? []) {
    if (adj.active === false || adj.rule === "info" || !adj.value) continue;
    const matching = priced.filter(({ product }) => !adj.categories?.length || adj.categories.includes(product.category));
    if (!matching.length) continue;
    const code = `adj:${adj.id}`;
    const base = { code, material: adj.rule !== "per_trip", detail: adj.description || "Pricing adjustment." };
    if (adj.rule === "per_unit") {
      matching.forEach(({ product, details: md }) =>
        out.push(line(`${adj.name}: ${product.name}`, product.unit, md.totalQty, adj.value, { ...base, code: `${code}:${md.productKey}` })));
    } else if (adj.rule === "per_m2") {
      const area = round2(matching.reduce((s, { details: md }) => s + (md.areaM2 ?? 0), 0));
      if (area) out.push(line(adj.name, "m²", area, adj.value, base));
    } else if (adj.rule === "percent_of_materials") {
      const amount = sumMoney(matching.flatMap((p) => p.lines.map((l) => l.lineTotal)));
      const charge = round2(amount * (adj.value / 100));
      if (charge) out.push(line(`${adj.name} (${adj.value}%)`, "", 1, charge, base));
    } else if (adj.rule === "per_pallet") {
      const count = matching.reduce((s, { details: md }) => s + md.pallets, 0);
      if (count) out.push(line(adj.name, "pallet", count, adj.value, { ...base, material: false }));
    } else if (adj.rule === "per_trip") {
      if (delivery) out.push(line(adj.name, "trip", delivery.trips, adj.value, base));
    } else if (adj.rule === "per_quote") {
      out.push(line(adj.name, "job", 1, adj.value, { ...base, material: false }));
    }
  }
  return out;
}

/** Customer-type discount on materials (products, surcharges and accessories). */
function materialsDiscount(job, lines, rates, settings, notes) {
  const type = pick(rates.discounts, job.customerType, "customerType");
  let percent = type.percent ?? 0;
  if (job.customerType === "negotiated") {
    percent = nonNegative(job.negotiatedPercent, "negotiatedPercent", 100);
    if (percent > settings.maxDiscountPercent) {
      throw new PricingError(
        `Negotiated discounts above ${settings.maxDiscountPercent}% need a manager. Use escalate_to_human.`,
      );
    }
  }
  const materials = round2(lines.filter((l) => l.material).reduce((s, l) => s + l.lineTotal, 0));
  if (type.minMaterials && materials < type.minMaterials) {
    notes.push(`${type.name} discount needs materials of at least ${settings.currency} ${type.minMaterials}; not applied.`);
    percent = 0;
  }
  if (!percent) return null;
  const amount = round2(materials * (percent / 100));
  return { type: job.customerType, name: type.name, percent, amount };
}

const MAX_CUSTOM_LINES = 30;

/**
 * A saved quotation: the job and extras priced as usual, then any unit-price
 * overrides (by line code) and manually added lines, before the customer
 * discount and VAT. Everything is still computed here, never by the model.
 *
 * @param {{job: object, extras?: Array, customLines?: Array, overrides?: object}} input
 */
export function calculateQuotation({ job, extras = [], customLines = [], overrides = {} }, { catalog, rates, settings }) {
  const clean = normalizeJob(job);
  const { lines, details } = priceJob(clean, rates);
  const extraLines = extras?.length ? priceCatalogLines(extras, catalog) : [];
  const all = [...lines, ...extraLines];

  const unused = new Set(Object.keys(overrides ?? {}));
  for (const l of all) {
    const o = overrides?.[l.code];
    if (o === undefined) continue;
    unused.delete(l.code);
    if (typeof o !== "number" || !Number.isFinite(o) || Math.abs(o) > 1e7) {
      throw new PricingError(`The price for "${l.name}" must be a number.`);
    }
    l.listUnitPrice ??= l.unitPrice;
    l.unitPrice = round2(o);
    l.lineTotal = round2(l.unitPrice * l.quantity);
    l.overridden = true;
  }
  if (!Array.isArray(customLines) || customLines.length > MAX_CUSTOM_LINES) {
    throw new PricingError(`A quotation can have at most ${MAX_CUSTOM_LINES} manual lines.`);
  }
  customLines.forEach((c, i) => {
    const name = String(c?.name ?? "").trim();
    if (!name) throw new PricingError(`Manual line ${i + 1} needs a description.`);
    const quantity = positive(c.quantity, `Quantity for "${name}"`, 1e7);
    if (typeof c.unitPrice !== "number" || !Number.isFinite(c.unitPrice) || Math.abs(c.unitPrice) > 1e7) {
      throw new PricingError(`The price for "${name}" must be a number.`);
    }
    all.push(line(name, String(c.unit ?? ""), quantity, c.unitPrice, {
      code: `custom:${i}`,
      detail: String(c.detail ?? ""),
      material: !!c.material,
      overridden: true,
      ...(c.vatExempt && { vatExempt: true }),
    }));
  });

  const discount = materialsDiscount(clean, all, rates, settings, details.notes);
  if (discount) {
    all.push(line(`${discount.name} discount (${discount.percent}% on materials)`, "", 1, -discount.amount, { code: "discount", detail: "Applied to materials only." }));
  }
  return {
    ...totals(all, settings, 0),
    details: { ...details, discount, negotiatedPercent: discount?.type === "negotiated" ? discount.percent : 0 },
    unusedOverrides: [...unused],
  };
}

/** Full quote for a job plus optional catalog extras (accessories). */
export function calculateJobQuote(rawJob, extras, ctx) {
  const { unusedOverrides, ...quote } = calculateQuotation({ job: rawJob, extras: extras ?? [] }, ctx);
  return quote;
}

/** Quotes that exceed the threshold, or carry a negotiated discount, wait for staff approval. */
export function needsApproval(quote, settings) {
  return quote.total > settings.autoApproveLimit || quote.discountPercent > 0 || (quote.details?.negotiatedPercent ?? 0) > 0;
}
