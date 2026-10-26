import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateJobQuote, calculateQuote, needsApproval, priceJob, PricingError } from "../src/pricing.js";
import { defaultCatalog, defaultRates, defaultSettings } from "../src/defaults.js";

const ctx = { catalog: defaultCatalog, rates: defaultRates, settings: defaultSettings };

const job = {
  productKey: "bosun_interlock_red",
  colour: "",
  finish: "",
  useCustomSize: false,
  lengthMm: 0,
  widthMm: 0,
  heightMm: 0,
  quantityMode: "area",
  quantity: 60,
  wastagePercent: 5,
  deliveryDistanceKm: 0,
  otherProvince: false,
  vehicle: "auto",
  offloading: "standard",
  difficultAccess: false,
  waitingHours: 0,
  returnPallets: false,
  additionalPacking: false,
  includeLabour: false,
  slope: "flat",
  groundPrep: "none",
  customerType: "standard",
  negotiatedPercent: 0,
};
const m6 = { ...job, productKey: "m6_block", colour: "charcoal", finish: "rockface", quantityMode: "units", quantity: 400 };
const total = (q) => q.lines.reduce((s, l) => s + l.lineTotal, 0);
const find = (q, start) => q.lines.find((l) => l.name.startsWith(start));

test("prices catalog extras with volume tiers and tax", () => {
  const q = calculateQuote([{ sku: "CEM-50", quantity: 40 }], ctx);
  assert.equal(q.lines[0].unitPrice, 109.25);
  assert.equal(q.total, 5025.5);
});

test("pavers use the published coverage rate, wastage and per-product pallets", () => {
  const q = calculateJobQuote(job, [], ctx);
  const d = q.details.materials[0];
  assert.equal(d.coveragePerM2, 50);
  assert.equal(d.coverageSource, "catalogue");
  assert.equal(d.netQty, 3000);
  assert.equal(d.totalQty, 3150);
  assert.deepEqual([d.fullPallets, d.partialPallet, d.pallets], [6, true, 7]);
  assert.equal(q.lines[0].lineTotal, 12600); // 3150 × R4.00
  assert.equal(find(q, "Full pallet").lineTotal, 360);
  assert.equal(find(q, "Partial pallet").lineTotal, 95);
  assert.equal(find(q, "Pallet deposit").lineTotal, 1750);
  assert.equal(q.subtotal, 14805);
  assert.equal(q.total, 17025.75);
  assert.equal(q.details.delivery, null);
});

test("built-in colours cost nothing extra; chosen colour and finish add surcharges", () => {
  assert.equal(calculateJobQuote(job, [], ctx).lines.filter((l) => /surcharge/.test(l.name)).length, 0);
  const q = calculateJobQuote(m6, [], ctx);
  assert.equal(q.details.materials[0].totalQty, 420);
  assert.equal(find(q, "Colour surcharge").lineTotal, 252); // 420 × 0.60
  assert.equal(find(q, "Finish surcharge").lineTotal, 630); // 420 × 1.50
  assert.throws(() => priceJob({ ...m6, colour: "red" }, defaultRates), /colour for M6/);
});

test("coverage is estimated from the size when there's no catalogue rate", () => {
  const { details } = priceJob({ ...job, productKey: "clay_stock", colour: "", quantity: 10 }, defaultRates);
  assert.equal(details.materials[0].coverageSource, "estimated from size");
  assert.equal(details.materials[0].coveragePerM2, 51.93); // 1e6 / (232 × 83)
  assert.match(details.notes[0], /typical size/);
  const custom = priceJob({ ...job, productKey: "clay_stock", useCustomSize: true, lengthMm: 290, widthMm: 140, heightMm: 90, quantity: 10 }, defaultRates);
  assert.equal(custom.details.materials[0].coveragePerM2, 33.33); // 1e6 / (300 × 100)
  assert.equal(custom.details.notes.length, 0);
});

test("m² and metre products are sold in their own unit", () => {
  const q = priceJob({ ...job, productKey: "vinyl_flooring", quantityMode: "units", quantity: 42.31 }, defaultRates);
  assert.equal(q.details.materials[0].totalQty, 44.6); // 42.4 × 1.05 = 44.52, rounded up to 0.1
  assert.throws(() => priceJob({ ...job, productKey: "smartstone_coping", quantityMode: "area" }, defaultRates), /sold per metre/);
});

test("delivery uses the distance bracket, vehicle by weight, offloading and extras", () => {
  const q = calculateJobQuote(
    { ...job, deliveryDistanceKm: 18, offloading: "crane", difficultAccess: true, waitingHours: 1.5 },
    [],
    ctx,
  );
  const d = q.details.delivery;
  assert.equal(d.bracket, "11–25 km");
  assert.equal(d.vehicle, "8-ton crane truck"); // 8,190 kg: two trips
  assert.equal(d.trips, 2);
  assert.equal(d.perTrip, 2575); // 1450 + 750 × 1.5
  assert.equal(find(q, "Crane offloading").lineTotal, 900);
  assert.equal(find(q, "Difficult site access").lineTotal, 900);
  assert.equal(find(q, "Additional waiting").lineTotal, 570);
  const light = priceJob({ ...job, quantity: 5, deliveryDistanceKm: 8 }, defaultRates).details.delivery;
  assert.equal(light.vehicle, "1-ton truck");
  const manual = calculateJobQuote({ ...m6, deliveryDistanceKm: 120, offloading: "manual" }, [], ctx);
  assert.equal(find(manual, "Manual offloading").lineTotal, 1260); // 7 pallets × 180
  assert.match(manual.details.delivery.bracket, /over 100 km/);
  assert.throws(() => priceJob({ ...job, deliveryDistanceKm: 10, vehicle: "truck_3t", offloading: "crane" }, defaultRates), /needs a crane/);
});

test("pallet return credit and additional packing", () => {
  const q = calculateJobQuote({ ...job, returnPallets: true, additionalPacking: true }, [], ctx);
  assert.equal(find(q, "Pallet return credit").lineTotal, -1400);
  assert.equal(find(q, "Additional packing").lineTotal, 525);
});

test("labour and ground prep use slope and access, with a minimum charge", () => {
  const q = priceJob({ ...job, includeLabour: true, slope: "gentle", groundPrep: "full", difficultAccess: true }, defaultRates);
  assert.equal(find(q, "Installation").unitPrice, 132); // 100 × 1.1 × 1.2
  assert.equal(find(q, "Ground").unitPrice, 203.5);
  const small = priceJob({ ...job, includeLabour: true, quantity: 5 }, defaultRates);
  assert.equal(find(small, "Installation").lineTotal, 2500);
});

test("customer discounts apply to materials only", () => {
  const contractor = calculateJobQuote({ ...job, customerType: "contractor" }, [], ctx);
  assert.equal(contractor.details.discount.amount, 945); // 7.5% of 12,600
  const bulkSmall = calculateJobQuote({ ...job, customerType: "bulk" }, [], ctx);
  assert.equal(bulkSmall.details.discount, null);
  assert.match(bulkSmall.details.notes[0], /Bulk purchase discount needs/);
  const bulk = calculateJobQuote({ ...job, customerType: "bulk", quantity: 100 }, [], ctx);
  assert.equal(bulk.details.discount.percent, 5);
  assert.throws(() => calculateJobQuote({ ...job, customerType: "negotiated", negotiatedPercent: 15 }, [], ctx), /need a manager/);
});

test("rejects bad job fields and custom-quote deliveries", () => {
  assert.throws(() => priceJob({ ...job, productKey: "marble" }, defaultRates), /productKey must be one of/);
  assert.throws(() => priceJob({ ...job, quantity: 0 }, defaultRates), PricingError);
  assert.throws(() => priceJob({ ...job, wastagePercent: 50 }, defaultRates), /wastagePercent/);
  assert.throws(() => priceJob({ ...job, deliveryDistanceKm: 400 }, defaultRates), /custom quote/);
  assert.throws(() => priceJob({ ...job, otherProvince: true }, defaultRates), /another province/);
});

test("a job can mix materials, each with its own parameters", () => {
  const { productKey, colour, finish, useCustomSize, lengthMm, widthMm, heightMm, quantityMode, quantity, wastagePercent, ...shared } = job;
  const pavers = { productKey, colour, finish, useCustomSize, lengthMm, widthMm, heightMm, quantityMode, quantity, wastagePercent };
  const blocks = { ...pavers, productKey: "m6_block", colour: "charcoal", finish: "rockface", quantityMode: "units", quantity: 400, wastagePercent: 5 };
  const bricks = { ...pavers, productKey: "clay_stock", quantityMode: "units", quantity: 1000, wastagePercent: 10 };
  const mixed = { ...shared, materials: [pavers, blocks, bricks], deliveryDistanceKm: 18 };
  const q = calculateJobQuote(mixed, [], ctx);
  const [p, b, c] = q.details.materials;
  // Each material keeps its own quantity, wastage, colour/finish and pallet size.
  assert.equal(p.totalQty, 3150);
  assert.equal(b.totalQty, 420);
  assert.equal(c.totalQty, 1100);
  assert.equal(find(q, "Colour surcharge").lineTotal, 252);
  assert.equal(find(q, "Finish surcharge").lineTotal, 630);
  assert.deepEqual([p.pallets, b.pallets, c.pallets], [7, 7, 3]);
  // Pallets and delivery cover the combined load.
  assert.equal(q.details.pallets, 17);
  assert.equal(find(q, "Partial pallet").quantity, 2); // the M6 blocks fill 7 whole pallets
  assert.equal(find(q, "Pallet deposit").quantity, 17);
  assert.equal(q.details.weightKg, p.weightKg + b.weightKg + c.weightKg);
  assert.equal(q.details.weightKg, 17790); // too heavy for one 8-ton trip on its own
  assert.equal(q.details.delivery.vehicle, "Third-party logistics");
  assert.equal(q.details.delivery.trips, 1);
  // Labour is priced per material, at each product's own rate.
  const labour = priceJob({ ...mixed, includeLabour: true }, defaultRates).lines.filter((l) => l.name.startsWith("Installation"));
  assert.equal(labour.length, 3);
  assert.match(labour[1].name, /M6 Concrete Building Block/);
  assert.equal(labour[1].unitPrice, 160);
  // Ground preparation covers the paving, not the walls.
  const prep = priceJob({ ...mixed, includeLabour: true, groundPrep: "light" }, defaultRates).lines.find((l) => l.name.startsWith("Ground"));
  assert.equal(prep.quantity, 60);
  // Errors name the material they're about.
  assert.throws(() => priceJob({ ...mixed, materials: [pavers, { ...blocks, colour: "red" }] }, defaultRates), /Material 2: colour/);
  assert.throws(() => priceJob({ ...shared, materials: [] }, defaultRates), /at least one material/);
});

test("large or negotiated-discount quotes need approval", () => {
  const small = calculateJobQuote(job, [], ctx);
  const big = calculateJobQuote({ ...job, quantity: 1000 }, [], ctx);
  const negotiated = calculateJobQuote({ ...job, customerType: "negotiated", negotiatedPercent: 5 }, [], ctx);
  const contractor = calculateJobQuote({ ...job, customerType: "contractor" }, [], ctx);
  assert.equal(needsApproval(small, defaultSettings), false);
  assert.equal(needsApproval(big, defaultSettings), true);
  assert.equal(needsApproval(negotiated, defaultSettings), true);
  assert.equal(needsApproval(contractor, defaultSettings), false);
  assert.equal(total(small), small.subtotal);
});
