import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/store.js";
import { defaultRates } from "../src/defaults.js";

test("the old JSON data file is imported once: settings, edited prices and quotes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-import-"));
  const file = path.join(dir, "db.json");
  const rates = structuredClone(defaultRates);
  rates.products.clay_stock.unitPrice = 3.75;
  rates.pallets.deposit = 275;
  fs.writeFileSync(file, JSON.stringify({
    settings: { companyName: "Profile Brick & Tile", quotePrefix: "PB&T", agentInstructions: "Be brief." },
    rates,
    catalog: [{ sku: "CEM-50", name: "Cement", unit: "bag", unitPrice: 120 }],
    conversations: {},
    quotes: {
      "Q-OLD1": {
        id: "Q-OLD1", number: "PB&T-2026-0007", conversationId: "conv_x", status: "sent", customer: { name: "Ann" },
        projectName: "Wall", siteAddress: "", projectSummary: "Old quote", notes: "", job: null,
        lines: [{ name: "Clay Stock Brick", unit: "brick", quantity: 100, unitPrice: 3.2, lineTotal: 320, material: true }],
        currency: "ZAR", subtotal: 320, discountPercent: 0, discount: 0, taxRatePercent: 15, tax: 48, total: 368,
        validUntil: "2026-05-01", createdAt: "2026-04-17T10:00:00.000Z",
      },
    },
    quoteSeq: 7,
  }));
  const db = await openDatabase({});
  t.after(() => db.close());
  const store = await createStore(db, { legacyFile: file });

  assert.equal((await store.getSettings()).agentInstructions, "Be brief.");
  assert.equal((await store.getProduct("clay_stock")).unitPrice, 3.75);
  assert.equal((await store.getProduct("cem_50")).unitPrice, 120);
  const { rates: live } = await store.getPricingContext();
  assert.equal(live.pallets.deposit, 275);
  const old = await store.quotations.get("Q-OLD1");
  assert.equal(old.total, 368);
  assert.equal(old.lines[0].unitPrice, 3.2);
  // New numbers continue after the imported ones.
  const next = await store.quotations.create({ input: { job: { materials: [{ productKey: "clay_stock", colour: "", finish: "", useCustomSize: false, lengthMm: 0, widthMm: 0, heightMm: 0, quantityMode: "units", quantity: 10, wastagePercent: 0 }], deliveryDistanceKm: 0, otherProvince: false, vehicle: "auto", offloading: "standard", difficultAccess: false, waitingHours: 0, returnPallets: false, additionalPacking: false, includeLabour: false, slope: "flat", groundPrep: "none", customerType: "standard", negotiatedPercent: 0 } } });
  assert.match(next.number, /-0008$/);

  // Running again doesn't import twice or undo later edits.
  const p = await store.getProduct("clay_stock");
  await store.updateProduct("clay_stock", { ...p, unitPrice: 4 }, p.version, { name: "Test" });
  await createStore(db, { legacyFile: file });
  assert.equal((await store.getProduct("clay_stock")).unitPrice, 4);
  assert.equal((await store.quotations.list()).length, 2);
});
