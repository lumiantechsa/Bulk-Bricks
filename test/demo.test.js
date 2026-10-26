// Public demo: no sign-in, example data, and complete isolation from the real system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeClient, formJob, say, startServer } from "./helpers.js";

test("a visitor can try the demo without signing in, isolated from the real system", async (t) => {
  const { req, close, store } = await startServer(fakeClient(Array(5).fill(say("Priced."))), "anthropic", { demo: {} });
  t.after(close);
  assert.deepEqual((await req("/api/demo")).body, { enabled: true });

  // No sign-in needed.
  const started = await req("/api/demo/start", { method: "POST" });
  assert.equal(started.status, 201);
  const visitor = started.body.token;
  assert.match(visitor, /^demo\./);
  const me = await req("/api/auth/me", { as: visitor });
  assert.equal(me.body.demo, true);
  assert.equal(me.body.user.name, "Demo visitor");

  // Example quotations are there; the real ones aren't.
  await store.quotations.create({ input: { job: formJob, customer: { name: "Real Customer" } }, user: null });
  const demoQuotes = (await req("/api/quotations", { as: visitor })).body;
  assert.equal(demoQuotes.length, 2);
  assert.ok(demoQuotes.every((q) => q.number.startsWith("DEMO-") && q.customer.company.startsWith("Example:")));
  assert.ok(!demoQuotes.some((q) => q.customer.name === "Real Customer"));
  // No real employees either.
  const staff = (await req("/api/staff", { as: visitor })).body.users.map((u) => u.username);
  assert.deepEqual(staff, ["demo"]);

  // The visitor can change prices, create quotations and delete things: only in the demo.
  const catalog = (await req("/api/catalog", { as: visitor })).body;
  const brick = catalog.products.find((p) => p.id === "clay_stock");
  const changed = await req("/api/products/clay_stock", { method: "PUT", as: visitor, body: JSON.stringify({ ...brick, unitPrice: 99 }) });
  assert.equal(changed.body.unitPrice, 99);
  assert.equal((await store.getProduct("clay_stock")).unitPrice, 3.2);
  const { body: chat } = await req("/api/chat", { method: "POST", as: visitor });
  const priced = await req(`/api/chat/${chat.id}/job`, { method: "POST", as: visitor, token: chat.token, body: JSON.stringify({ job: formJob }) });
  assert.equal(priced.status, 200);
  assert.equal(priced.body.transcript.find((e) => e.type === "estimate").estimate.lines[0].unitPrice, 99);
  for (const q of demoQuotes) assert.equal((await req(`/api/quotations/${q.id}`, { method: "DELETE", as: visitor })).status, 200);
  assert.equal((await store.quotations.list()).length, 1);
  assert.equal((await req("/api/quotations", { as: "admin" })).body.length, 1);
  assert.equal((await req(`/api/chat/${chat.id}`, { as: "admin", token: chat.token })).status, 404);

  // Two visitors don't see each other's changes.
  const other = (await req("/api/demo/start", { method: "POST" })).body.token;
  assert.equal((await req("/api/catalog", { as: other })).body.products.find((p) => p.id === "clay_stock").unitPrice, 3.2);
  assert.equal((await req("/api/quotations", { as: other })).body.length, 2);

  // A made-up demo token gets nowhere.
  const forged = `demo.${"0".repeat(16)}.${"0".repeat(64)}`;
  assert.equal((await req("/api/quotations", { as: forged })).status, 401);
  assert.equal((await req("/api/quotations", { as: "demo.junk" })).status, 401);
});

test("demo limits: starts per address, assistant requests, and switching it off", async (t) => {
  const { req, close } = await startServer(fakeClient(Array(5).fill(say("OK"))), "anthropic", { demo: { startsPerHour: 2, maxAiCalls: 1 } });
  t.after(close);
  const visitor = (await req("/api/demo/start", { method: "POST" })).body.token;
  await req("/api/demo/start", { method: "POST" });
  assert.equal((await req("/api/demo/start", { method: "POST" })).status, 429);
  const { body: chat } = await req("/api/chat", { method: "POST", as: visitor });
  const send = () => req(`/api/chat/${chat.id}/messages`, { method: "POST", as: visitor, token: chat.token, body: JSON.stringify({ text: "Hi" }) });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);

  const off = await startServer(fakeClient([]));
  t.after(off.close);
  assert.deepEqual((await off.req("/api/demo")).body, { enabled: false });
  assert.equal((await off.req("/api/demo/start", { method: "POST" })).status, 401);
});

test("an ended demo asks the visitor to start again", async (t) => {
  const { req, close, demo } = await startServer(fakeClient([]), "anthropic", { demo: {} });
  t.after(close);
  const visitor = (await req("/api/demo/start", { method: "POST" })).body.token;
  assert.equal(demo.sandboxCount(), 1);
  await demo.closeAll();
  const r = await req("/api/quotations", { as: visitor });
  assert.equal(r.status, 401);
  assert.equal(r.body.demoExpired, true);
});
