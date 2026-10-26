// The upgrade's acceptance scenarios: shared price list, AI product entry,
// saved quotations with price snapshots, deletion, permissions and conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeClient, fakeOpenAI, formJob, startServer, toolUse } from "./helpers.js";

const jobFor = (productKey, quantity = 1000) => ({ ...formJob, materials: [{ ...formJob.materials[0], productKey, quantity, wastagePercent: 0 }] });

// Listens to the live event stream like a browser does.
async function listen(base, token) {
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } });
  const reader = res.body.getReader();
  const events = [];
  let buffer = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += new TextDecoder().decode(value);
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const p of parts) if (p.startsWith("data: ")) events.push(JSON.parse(p.slice(6)));
    }
  })();
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("event not received");
  };
  return { events, waitFor, stop: () => reader.cancel().catch(() => {}) };
}

async function createQuotation(req, as, productKey = "cement_stock") {
  const { body: chat } = await req("/api/chat", { method: "POST", as });
  const job = jobFor(productKey);
  job.materials[0].colour = "grey";
  job.materials[0].finish = "standard";
  await req(`/api/chat/${chat.id}/job`, { method: "POST", as, token: chat.token, body: JSON.stringify({ job }) });
  const [q] = (await req("/api/quotations?status=draft", { as })).body;
  return (await req(`/api/quotations/${q.id}`, { as })).body;
}

test("Test 1: a price change reaches everyone live; saved quotations keep their price until refreshed", async (t) => {
  const { req, base, tokens, close } = await startServer(fakeClient(Array(10).fill({ stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] })));
  t.after(close);

  // Set the brick to R5.00 and save a quotation with it.
  let product = (await req("/api/catalog", { as: "admin" })).body.products.find((p) => p.id === "cement_stock");
  product = (await req("/api/products/cement_stock", { method: "PUT", as: "admin", body: JSON.stringify({ ...product, unitPrice: 5 }) })).body;
  const saved = await createQuotation(req, "sam");
  assert.equal(saved.lines[0].unitPrice, 5);
  assert.equal(saved.lines[0].lineTotal, 5000);

  // Employee B is watching; employee A changes the price to R5.50.
  const b = await listen(base, tokens.sam);
  t.after(() => b.stop());
  const updated = await req("/api/products/cement_stock", { method: "PUT", as: "admin", body: JSON.stringify({ ...product, unitPrice: 5.5 }) });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.unitPrice, 5.5);
  await b.waitFor((e) => e.type === "product" && e.id === "cement_stock");
  // ...and B sees R5.50 when the page reloads its data.
  const seen = (await req("/api/catalog", { as: "sam" })).body.products.find((p) => p.id === "cement_stock");
  assert.equal(seen.unitPrice, 5.5);

  // Price history keeps every change with who made it.
  const { body: brick } = await req("/api/products/cement_stock/history", { as: "sam" });
  assert.deepEqual(brick.slice(0, 2).map((h) => [h.oldValue, h.newValue, h.changedBy]), [[5, 5.5, "Administrator"], [2.4, 5, "Administrator"]]);

  // A new quotation uses R5.50.
  const fresh = await createQuotation(req, "admin");
  assert.equal(fresh.lines[0].unitPrice, 5.5);

  // The saved one still says R5.00, even after an edit.
  const reopened = (await req(`/api/quotations/${saved.id}`, { as: "sam" })).body;
  assert.equal(reopened.lines[0].unitPrice, 5);
  const edited = await req(`/api/quotations/${saved.id}`, {
    method: "PUT", as: "sam", body: JSON.stringify({ version: reopened.version, input: { job: jobFor("cement_stock", 2000) } }),
  });
  assert.equal(edited.status, 400); // cement stock needs a colour: the job is validated like the form
  const job = jobFor("cement_stock", 2000);
  job.materials[0].colour = "grey";
  job.materials[0].finish = "standard";
  const ok = await req(`/api/quotations/${saved.id}`, { method: "PUT", as: "sam", body: JSON.stringify({ version: reopened.version, input: { job } }) });
  assert.equal(ok.body.lines[0].unitPrice, 5);
  assert.equal(ok.body.lines[0].quantity, 2000);

  // Refresh using current prices: shows the differences first, then applies them.
  const diff = (await req(`/api/quotations/${saved.id}/compare`, { as: "sam" })).body;
  const line = diff.changes.find((c) => c.code === "m0:product");
  assert.deepEqual([line.before.unitPrice, line.after.unitPrice], [5, 5.5]);
  assert.equal(diff.totals.total.before, ok.body.total);
  const stale = await req(`/api/quotations/${saved.id}/refresh`, { method: "POST", as: "sam", body: JSON.stringify({ version: reopened.version }) });
  assert.equal(stale.status, 409);
  const refreshed = await req(`/api/quotations/${saved.id}/refresh`, { method: "POST", as: "sam", body: JSON.stringify({ version: diff.version }) });
  assert.equal(refreshed.body.lines[0].unitPrice, 5.5);
  assert.equal(refreshed.body.total, diff.totals.total.after);

  // Every save is a revision.
  const revisions = (await req(`/api/quotations/${saved.id}/revisions`, { as: "sam" })).body;
  assert.deepEqual(revisions.map((r) => [r.revision, r.action]), [[3, "refreshed"], [2, "edited"], [1, "created"]]);
});

test("Test 2: AI product entry extracts, asks for what's missing, and the product is quotable at once", async (t) => {
  const client = fakeOpenAI([
    // The model "invents" a weight that isn't in the text; it must be dropped.
    {
      role: "assistant", content: null,
      tool_calls: [{ id: "x", type: "function", function: { name: "record_product", arguments: JSON.stringify({
        name: "Charcoal Paving Brick", category: "paver", description: null, sku: null, unit: "paver", unitPrice: 7.5,
        lengthMm: 200, widthMm: 100, heightMm: 50, unitsPerPallet: 500, weightKg: 2.4, coveragePerM2: null, colour: "Charcoal",
        finish: null, labourRate: null, defaultWastagePercent: null, minQuantity: null, deliveryRequirement: null, vatTreatment: null,
        questions: [],
      }) } }],
    },
  ]);
  const { req, base, tokens, close } = await startServer(client, "openai");
  t.after(close);

  const text = "Add a new charcoal paving brick, 200 by 100 by 50 millimetres, costing R7.50 each, with 500 bricks per pallet.";
  assert.equal((await req("/api/products/extract", { method: "POST", as: "sam", body: JSON.stringify({ text }) })).status, 403);
  const { body: extracted } = await req("/api/products/extract", { method: "POST", as: "admin", body: JSON.stringify({ text }) });
  assert.equal(extracted.draft.unitPrice, 7.5);
  assert.deepEqual([extracted.draft.lengthMm, extracted.draft.widthMm, extracted.draft.heightMm], [200, 100, 50]);
  assert.equal(extracted.draft.unitsPerPallet, 500);
  assert.equal(extracted.draft.category, "paver");
  assert.equal(extracted.draft.layout, "paving");
  assert.equal(extracted.draft.weightKg, undefined);
  assert.deepEqual(extracted.unconfirmed, ["weightKg"]);
  assert.deepEqual(extracted.missing.map((m) => m.key), ["weightKg"]);
  assert.match(client.calls[0].messages[0].content, /Never estimate/);

  // Saving without the missing field is refused.
  const incomplete = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify(extracted.draft) });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error, /Weight/);

  const b = await listen(base, tokens.sam);
  t.after(() => b.stop());
  const created = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify({ ...extracted.draft, weightKg: 2.3, via: "ai" }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, "charcoal_paving_brick");
  await b.waitFor((e) => e.type === "product" && e.action === "created");

  // Employee B can quote it straight away.
  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  assert.ok(chat.formOptions.products.some((p) => p.key === "charcoal_paving_brick" && p.unitPrice === 7.5));
  const r = await req(`/api/chat/${chat.id}/job`, {
    method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ job: jobFor("charcoal_paving_brick", 500) }),
  });
  // The fake model has no reply left, so the chat answers 502, but the job was priced and saved first.
  const estimate = r.body.transcript.find((e) => e.type === "estimate").estimate;
  assert.equal(estimate.lines[0].lineTotal, 3750);
  const audit = (await req("/api/audit", { as: "admin" })).body;
  assert.ok(audit.some((a) => a.action === "product.create" && a.details.via === "ai"));
});

test("Test 3 and 7: shared quotations, edits persist, simultaneous edits are detected", async (t) => {
  const { req, close } = await startServer(fakeClient(Array(5).fill({ stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] })));
  t.after(close);
  const q = await createQuotation(req, "admin");

  // Employee B finds the card and opens it.
  const cards = (await req("/api/quotations?search=" + encodeURIComponent(q.number), { as: "sam" })).body;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].createdByName, "Administrator");
  const a = (await req(`/api/quotations/${q.id}`, { as: "admin" })).body;
  const b = (await req(`/api/quotations/${q.id}`, { as: "sam" })).body;

  const job = structuredClone(b.job);
  job.materials[0].quantity = 3000;
  const savedB = await req(`/api/quotations/${q.id}`, {
    method: "PUT", as: "sam", body: JSON.stringify({ version: b.version, input: { job, customer: { name: "Lee", company: "Lee Builders" }, notes: "Call first" } }),
  });
  assert.equal(savedB.status, 200);
  assert.equal(savedB.body.lines[0].quantity, 3000);

  // A saves on top of the old version: rejected, not overwritten.
  const job2 = structuredClone(a.job);
  job2.materials[0].quantity = 10;
  const clash = await req(`/api/quotations/${q.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ version: a.version, input: { job: job2 } }) });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Sam Sales saved this quotation/);
  assert.equal(clash.body.current.lines[0].quantity, 3000);

  // Reopening shows B's changes.
  const again = (await req(`/api/quotations/${q.id}`, { as: "admin" })).body;
  assert.equal(again.lines[0].quantity, 3000);
  assert.equal(again.customer.company, "Lee Builders");
  assert.equal(again.notes, "Call first");
  assert.equal(again.updatedByName, "Sam Sales");

  // Line prices need permission; managers can override and add manual lines.
  const priced = await req(`/api/quotations/${q.id}`, {
    method: "PUT", as: "sam", body: JSON.stringify({ version: again.version, input: { overrides: { "m0:product": 1 } } }),
  });
  assert.equal(priced.status, 403);
  const managed = await req(`/api/quotations/${q.id}`, {
    method: "PUT", as: "admin", body: JSON.stringify({
      version: again.version,
      input: { overrides: { "m0:product": 2 }, customLines: [{ name: "Site visit", unit: "visit", quantity: 1, unitPrice: 450 }], extras: [{ sku: "CEM-50", quantity: 2 }] },
    }),
  });
  assert.equal(managed.status, 200);
  const line = managed.body.lines[0];
  assert.deepEqual([line.unitPrice, line.lineTotal, line.overridden, line.listUnitPrice], [2, 6000, true, 2.4]);
  assert.ok(managed.body.lines.some((l) => l.name === "Site visit" && l.lineTotal === 450));
  assert.ok(managed.body.lines.some((l) => l.sku === "CEM-50"));
  assert.equal(managed.body.subtotal, Math.round(managed.body.lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100);
  // The salesperson can still edit quantities, keeping the manager's prices.
  const kept = await req(`/api/quotations/${q.id}`, {
    method: "PUT", as: "sam", body: JSON.stringify({ version: managed.body.version, input: { notes: "Updated" } }),
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.lines[0].unitPrice, 2);

  // Issuing a draft gives it a status; the numbers don't change.
  const issued = await req(`/api/quotations/${q.id}/status`, { method: "POST", as: "sam", body: JSON.stringify({ action: "issue", version: kept.body.version }) });
  assert.equal(issued.body.status, "sent");
  assert.equal(issued.body.total, kept.body.total);
});

test("Test 4: the document data is the latest saved version", async (t) => {
  const { req, close } = await startServer(fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] }]));
  t.after(close);
  const q = await createQuotation(req, "sam");
  const job = structuredClone(q.job);
  job.materials[0].quantity = 1234;
  const saved = (await req(`/api/quotations/${q.id}`, { method: "PUT", as: "sam", body: JSON.stringify({ version: q.version, input: { job } }) })).body;
  const reopened = (await req(`/api/quotations/${q.id}`, { as: "sam" })).body;
  assert.equal(reopened.lines[0].quantity, 1234);
  assert.equal(reopened.total, saved.total);
  assert.equal((await req(`/api/quotations/${q.id}/pdf`, { method: "POST", as: "sam" })).status, 200);
  const audit = (await req("/api/audit", { as: "admin" })).body;
  assert.ok(audit.some((a) => a.action === "quotation.pdf" && a.details.total === saved.total));
  // Old revisions can still be looked at.
  const first = (await req(`/api/quotations/${q.id}/revisions/1`, { as: "sam" })).body;
  assert.equal(first.lines[0].quantity, 1000);
});

test("Test 5: deleting is for authorised staff, recoverable, and hides the quotation", async (t) => {
  const { req, close } = await startServer(fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] }]));
  t.after(close);
  const q = await createQuotation(req, "sam");
  assert.equal((await req(`/api/quotations/${q.id}`, { method: "DELETE", as: "sam" })).status, 403);
  assert.equal((await req(`/api/quotations/${q.id}`, { method: "DELETE", as: "admin" })).status, 200);
  assert.equal((await req("/api/quotations", { as: "sam" })).body.length, 0);
  assert.equal((await req(`/api/quotations/${q.id}`, { as: "sam" })).status, 404);
  assert.equal((await req(`/api/quotations/${q.id}?deleted=1`, { as: "sam" })).status, 404);
  assert.equal((await req("/api/quotations?deleted=1", { as: "sam" })).status, 403);
  const deleted = (await req("/api/quotations?deleted=1", { as: "admin" })).body;
  assert.equal(deleted[0].id, q.id);
  assert.equal((await req(`/api/quotations/${q.id}?deleted=1`, { as: "admin" })).status, 200);
  assert.equal((await req(`/api/quotations/${q.id}/restore`, { method: "POST", as: "admin" })).status, 200);
  assert.equal((await req("/api/quotations", { as: "sam" })).body.length, 1);
});

test("Test 6: the backend rejects price changes from a salesperson", async (t) => {
  const { req, close } = await startServer(fakeClient([]));
  t.after(close);
  const catalog = (await req("/api/catalog", { as: "sam" })).body;
  const p = catalog.products.find((x) => x.id === "clay_stock");
  const v = catalog.variables.find((x) => x.id === "rate.pallets.deposit");
  assert.equal((await req("/api/products/clay_stock", { method: "PUT", as: "sam", body: JSON.stringify({ ...p, unitPrice: 0.01 }) })).status, 403);
  assert.equal((await req("/api/products", { method: "POST", as: "sam", body: JSON.stringify({ ...p, name: "Cheap" }) })).status, 403);
  assert.equal((await req(`/api/pricing-variables/${v.id}`, { method: "PUT", as: "sam", body: JSON.stringify({ ...v, value: 0 }) })).status, 403);
  assert.equal((await req("/api/products/clay_stock", { method: "PUT", body: JSON.stringify({ ...p, unitPrice: 0.01 }) })).status, 401);
  const after = (await req("/api/catalog", { as: "admin" })).body.products.find((x) => x.id === "clay_stock");
  assert.equal(after.unitPrice, 3.2);
  // Salespeople see active products only.
  await req("/api/products/clay_stock", { method: "PUT", as: "admin", body: JSON.stringify({ ...after, active: false }) });
  assert.ok(!(await req("/api/catalog", { as: "sam" })).body.products.some((x) => x.id === "clay_stock"));
  assert.ok((await req("/api/catalog", { as: "admin" })).body.products.some((x) => x.id === "clay_stock"));
});

test("pricing variables drive the calculation and are validated", async (t) => {
  const { req, close } = await startServer(fakeClient(Array(5).fill({ stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] })));
  t.after(close);
  const { body: catalog } = await req("/api/catalog", { as: "admin" });
  const deposit = catalog.variables.find((v) => v.id === "rate.pallets.deposit");
  assert.equal(deposit.value, 250);

  // Editing a rate changes the next estimate.
  const changed = await req(`/api/pricing-variables/${deposit.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ version: deposit.version, value: 300 }) });
  assert.equal(changed.body.value, 300);
  const stale = await req(`/api/pricing-variables/${deposit.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ version: deposit.version, value: 1 }) });
  assert.equal(stale.status, 409);

  // A custom per-unit surcharge for paving, using a fixed rule.
  const bad = await req("/api/pricing-variables", { method: "POST", as: "admin", body: JSON.stringify({ kind: "adjustment", name: "Hack", rule: "eval", value: 1 }) });
  assert.equal(bad.status, 400);
  const adj = await req("/api/pricing-variables", {
    method: "POST", as: "admin",
    body: JSON.stringify({ kind: "adjustment", name: "Paving levy", data_type: "currency", rule: "per_unit", value: 0.25, unit: "per paver", categories: ["paver"] }),
  });
  assert.equal(adj.status, 201);
  // A new delivery vehicle.
  const vehicle = await req("/api/pricing-variables", {
    method: "POST", as: "admin",
    body: JSON.stringify({ kind: "vehicle", name: "Flatbed", fields: { capacityKg: 12000, pallets: 10, baseFee: 1800, distanceFactor: 1.3, crane: false } }),
  });
  assert.equal(vehicle.status, 201);
  const badVehicle = await req("/api/pricing-variables", { method: "POST", as: "admin", body: JSON.stringify({ kind: "vehicle", name: "X", fields: { capacityKg: -1 } }) });
  assert.equal(badVehicle.status, 400);

  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  assert.ok(chat.formOptions.vehicles.some((v) => v.name === "Flatbed"));
  const job = { ...jobFor("bosun_bond_grey", 1000), materials: [{ ...jobFor("bosun_bond_grey", 1000).materials[0] }] };
  const r = await req(`/api/chat/${chat.id}/job`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ job }) });
  const est = r.body.transcript.find((e) => e.type === "estimate").estimate;
  assert.equal(est.lines.find((l) => l.name === "Pallet deposit").unitPrice, 300);
  const levy = est.lines.find((l) => l.name.startsWith("Paving levy"));
  assert.equal(levy.lineTotal, 250);

  // The calculator always needs at least one of each required kind.
  const slopes = catalog.variables.filter((v) => v.kind === "slope");
  for (const s of slopes.slice(0, -1)) {
    await req(`/api/pricing-variables/${s.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ version: s.version, active: false }) });
  }
  const last = slopes.at(-1);
  const refused = await req(`/api/pricing-variables/${last.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ version: last.version, active: false }) });
  assert.equal(refused.status, 400);
});

test("products validate category-specific fields and delivery requirements", async (t) => {
  const { req, close } = await startServer(fakeClient([]));
  t.after(close);
  const base = { name: "Big slab", category: "paver", unit: "unit", unitPrice: 120, unitsPerPallet: 20, weightKg: 60, deliveryRequirement: "crane", labourRate: 90 };
  const noPallet = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify({ ...base, unitsPerPallet: null }) });
  assert.match(noPallet.body.error, /Units per pallet/);
  const badUnit = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify({ ...base, unit: "pallet" }) });
  assert.match(badUnit.body.error, /Unit for Paving/);
  const created = (await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify(base) })).body;
  // A labour service is sold by the hour, no pallets needed.
  const service = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify({ name: "Supervisor on site", category: "service", unit: "hour", unitPrice: 350, vatTreatment: "standard" }) });
  assert.equal(service.status, 201);
  const dupe = await req("/api/products", { method: "POST", as: "admin", body: JSON.stringify({ ...base, name: "Other", sku: created.sku }) });
  assert.equal(dupe.status, 409);

  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  const job = { ...jobFor(created.id, 10), deliveryDistanceKm: 10 };
  const r = await req(`/api/chat/${chat.id}/job`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ job }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /must be offloaded by crane/);
  assert.ok(chat.formOptions.extras.some((e) => e.sku === service.body.sku && e.kind === "service"));
});
