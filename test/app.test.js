import { test } from "node:test";
import assert from "node:assert/strict";
import { brickJob, fakeClient, fakeOpenAI, formJob, say, startServer, toolUse } from "./helpers.js";

test("employee gets a quote, a manager approves it, it's marked accepted", async (t) => {
  const client = fakeClient([
    toolUse("t0", "set_job_details", { ...brickJob, productKey: "agate_satin_fbx", quantity: 10000, deliveryDistanceKm: 30 }),
    toolUse("t1", "save_customer_details", { name: "Dana", email: "dana@example.com", company: "Dana's Deli", phone: "" }),
    toolUse("t2", "submit_quote", {
      extras: [{ sku: "SAND-BLD", quantity: 3 }],
      project_name: "Boundary wall",
      site_address: "45 Kingfisher Road, Beacon Bay",
      project_summary: "Boundary wall bricks",
      notes: "Delivery only, no installation.",
    }),
    say("Your quote is with our team for approval."),
    // After staff approval the next turn sees the system update.
    (params) => {
      const lastUser = params.messages.at(-1);
      assert.match(JSON.stringify(lastUser), /Staff approved quote/);
      return say("Great news, it's approved!");
    },
  ]);
  const { req, close } = await startServer(client);
  t.after(close);

  // The assistant is for signed-in staff only.
  assert.equal((await req("/api/chat", { method: "POST" })).status, 401);
  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  assert.ok(chat.token);

  const r1 = await req(`/api/chat/${chat.id}/messages`, {
    method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ text: "10,000 Agate Satin FBX, 30 km away. Dana, dana@example.com" }),
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.quotes.length, 1);
  const quote = r1.body.quotes[0];
  assert.equal(quote.status, "pending_review");
  // The estimate's draft became the quote, so it keeps the first number.
  assert.match(quote.number, new RegExp(`^PB&T-${new Date().getFullYear()}-0001$`));
  assert.equal(quote.projectName, "Boundary wall");
  assert.equal(quote.customer.company, "Dana's Deli");
  assert.match(quote.lines[0].detail, /5% wastage/);
  assert.equal(r1.body.quoteDocument.companyName, "Profile Brick & Tile");
  assert.equal(quote.details.materials[0].totalQty, 10500);
  assert.equal(quote.lines.at(-1).sku, "SAND-BLD");
  assert.ok(r1.body.transcript.some((t) => t.type === "estimate" && t.source === "agent" && t.quotationId === quote.id));
  assert.equal(r1.body.job.materials.length, 1);
  assert.equal(r1.body.job.materials[0].quantity, 10000);
  assert.equal(r1.body.transcript.at(-1).text, "Your quote is with our team for approval.");

  const lastCall = client.calls.at(-1);
  assert.equal(lastCall.messages.at(-1).content[0].type, "tool_result");
  assert.equal(lastCall.model, "claude-opus-5-5");

  // It's saved under Quotations with the employee responsible.
  const list = await req("/api/quotations", { as: "admin" });
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].createdByName, "Sam Sales");

  // Other people can't read the chat.
  assert.equal((await req(`/api/chat/${chat.id}`, { as: "sam", token: "wrong" })).status, 404);
  assert.equal((await req(`/api/chat/${chat.id}/quotes/${quote.id}/accept`, { method: "POST", as: "sam", token: chat.token })).status, 409);

  // Only managers approve.
  const denied = await req(`/api/quotations/${quote.id}/status`, { method: "POST", as: "sam", body: JSON.stringify({ action: "approve" }) });
  assert.equal(denied.status, 403);
  const approved = await req(`/api/quotations/${quote.id}/status`, { method: "POST", as: "admin", body: JSON.stringify({ action: "approve" }) });
  assert.equal(approved.body.status, "sent");

  const r2 = await req(`/api/chat/${chat.id}/messages`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ text: "Any update?" }) });
  assert.equal(r2.body.transcript.at(-1).text, "Great news, it's approved!");

  const accepted = await req(`/api/chat/${chat.id}/quotes/${quote.id}/accept`, { method: "POST", as: "sam", token: chat.token });
  assert.equal(accepted.body.quotes[0].status, "accepted");

  const overview = await req("/api/admin/overview", { as: "admin" });
  assert.equal(overview.body.quotes, 1);
  assert.equal(overview.body.conversionRate, 1);

  // "New chat" deletes the chat, but its quotations stay saved.
  assert.equal((await req(`/api/chat/${chat.id}`, { method: "DELETE", as: "sam", token: "wrong" })).status, 404);
  assert.equal((await req(`/api/chat/${chat.id}`, { method: "DELETE", as: "sam", token: chat.token })).status, 200);
  assert.equal((await req(`/api/chat/${chat.id}`, { as: "sam", token: chat.token })).status, 404);
  assert.equal((await req("/api/quotations", { as: "sam" })).body.length, 1);
});

test("tool errors go back to the model and managers can take over", async (t) => {
  const client = fakeClient([
    toolUse("t1", "calculate_quote", { extras: [] }),
    (params) => {
      const result = params.messages.at(-1).content[0];
      assert.equal(result.is_error, true);
      assert.match(result.content, /No job details yet/);
      return toolUse("t2", "escalate_to_human", { reason: "Wants marble pavers", urgency: "normal" });
    },
    say("I've asked a colleague to help with that."),
  ]);
  const { req, close } = await startServer(client);
  t.after(close);

  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  await req(`/api/chat/${chat.id}/messages`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ text: "Marble pavers please" }) });

  // Supervising chats is a manager permission.
  assert.equal((await req("/api/admin/conversations", { as: "sam" })).status, 403);
  const convs = await req("/api/admin/conversations", { as: "admin" });
  assert.equal(convs.body[0].status, "needs_human");

  await req(`/api/admin/conversations/${chat.id}`, { method: "PATCH", as: "admin", body: JSON.stringify({ aiPaused: true }) });
  await req(`/api/admin/conversations/${chat.id}/messages`, { method: "POST", as: "admin", body: JSON.stringify({ text: "Hi, manager here!" }) });

  // While paused the AI isn't called.
  const r = await req(`/api/chat/${chat.id}/messages`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ text: "Hi" }) });
  assert.equal(r.status, 200);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(r.body.transcript.slice(-2).map((m) => m.role), ["staff", "customer"]);
  assert.equal(r.body.transcript.at(-2).author, "Administrator");
});

test("works end to end with OpenAI from the job form", async (t) => {
  const oaTool = (id, name, args) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
  });
  const client = fakeOpenAI([
    (params) => {
      assert.match(params.messages.at(-1).content, /<job_form>/);
      return { role: "assistant", content: "Looks good. Who's the customer?" };
    },
    oaTool("c1", "save_customer_details", { name: "Ali", email: "ali@example.com", company: "", phone: "" }),
    oaTool("c2", "submit_quote", "{not json"),
    (params) => {
      const last = params.messages.at(-1);
      assert.equal(last.role, "tool");
      assert.match(last.content, /not valid JSON/);
      return oaTool("c3", "submit_quote", { extras: [], project_summary: "Clay stock bricks, collected", notes: "" });
    },
    { role: "assistant", content: "Here's your quote!" },
  ]);
  const { req, close } = await startServer(client, "openai");
  t.after(close);

  const { body: chat } = await req("/api/chat", { method: "POST", as: "sam" });
  assert.ok(chat.formOptions.products.length);
  assert.ok(chat.formOptions.categories.some((c) => c.key === "paver"));

  // Invalid form input is rejected without calling the model.
  const bad = await req(`/api/chat/${chat.id}/job`, {
    method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ job: { ...formJob, materials: [{ ...formJob.materials[0], productKey: "gold_brick" }] } }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /productKey must be one of/);
  assert.equal(client.calls.length, 0);

  const f = await req(`/api/chat/${chat.id}/job`, { method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ job: formJob }) });
  assert.equal(f.status, 200);
  assert.deepEqual(f.body.job, formJob);
  assert.equal(f.body.transcript.find((t) => t.type === "estimate").estimate.total, 4973.75);
  // The estimate is saved as a draft quotation straight away.
  const drafts = await req("/api/quotations?status=draft", { as: "sam" });
  assert.equal(drafts.body.length, 1);
  assert.equal(drafts.body[0].total, 4973.75);

  const r = await req(`/api/chat/${chat.id}/messages`, {
    method: "POST", as: "sam", token: chat.token, body: JSON.stringify({ text: "Ali, ali@example.com. Go ahead." }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.transcript.at(-1).text, "Here's your quote!");
  assert.equal(r.body.quotes[0].status, "sent");
  assert.equal(r.body.quotes[0].total, 4973.75);
  assert.equal(r.body.quotes[0].id, drafts.body[0].id);
  assert.equal(r.body.quotes[0].customer.name, "Ali");

  const first = client.calls[0];
  assert.equal(first.tools.length, 6);
  assert.equal(first.model, "gpt-5.5");
  assert.equal(first.messages[0].role, "system");
  assert.equal(first.tools[0].type, "function");
  assert.equal(first.tools[0].function.strict, true);
});

test("settings are validated and need permission", async (t) => {
  const { req, close } = await startServer(fakeClient([]));
  t.after(close);
  assert.equal((await req("/api/admin/settings", { method: "PUT", as: "sam", body: JSON.stringify({ taxRatePercent: 20 }) })).status, 403);
  assert.equal((await req("/api/admin/settings", { method: "PUT", as: "admin", body: JSON.stringify({ taxRatePercent: "x" }) })).status, 400);
  const s = await req("/api/admin/settings", { method: "PUT", as: "admin", body: JSON.stringify({ taxRatePercent: "20", companyName: "X" }) });
  assert.equal(s.body.taxRatePercent, 20);
  assert.equal(s.body.companyName, "X");
  const audit = await req("/api/audit", { as: "admin" });
  assert.ok(audit.body.some((a) => a.action === "settings.update" && a.user === "Administrator"));
});

test("sign-in, sessions and staff management", async (t) => {
  const { req, close, tokens } = await startServer(fakeClient([]));
  t.after(close);
  const wrong = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "sam", password: "nope-nope" }) });
  assert.equal(wrong.status, 401);
  const me = await req("/api/auth/me", { as: "sam" });
  assert.equal(me.body.user.role, "sales");
  assert.deepEqual(me.body.user.permissions, []);
  // Salespeople can't manage staff.
  assert.equal((await req("/api/staff", { as: "sam" })).status, 403);
  // An administrator can grant a salesperson pricing rights.
  const { body: staff } = await req("/api/staff", { as: "admin" });
  const sam = staff.users.find((u) => u.username === "sam");
  const granted = await req(`/api/staff/${sam.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ permissions: ["manage_pricing"] }) });
  assert.deepEqual(granted.body.permissions, ["manage_pricing"]);
  // The last administrator can't be demoted.
  const admin = staff.users.find((u) => u.username === "admin");
  assert.equal((await req(`/api/staff/${admin.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ role: "sales" }) })).status, 400);
  // Deactivating someone ends their sessions.
  await req(`/api/staff/${sam.id}`, { method: "PUT", as: "admin", body: JSON.stringify({ active: false }) });
  assert.equal((await req("/api/auth/me", { as: tokens.sam })).status, 401);
  await req("/api/auth/logout", { method: "POST", as: "admin" });
  assert.equal((await req("/api/auth/me", { as: "admin" })).status, 401);
});

test("the shared Test sign-in is created once and never reset", async (t) => {
  const { req, store, close } = await startServer(fakeClient([]));
  t.after(close);
  assert.ok(await store.auth.ensureAccount({ username: "Test", name: "Test", password: "Test" }));
  const login = (password) => req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "Test", password }) });
  const ok = await login("Test");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, "admin");
  // A changed password survives the next start.
  const changed = await req("/api/auth/password", { method: "POST", as: ok.body.token, body: JSON.stringify({ currentPassword: "Test", newPassword: "a-longer-password" }) });
  assert.equal(changed.status, 200);
  assert.equal(await store.auth.ensureAccount({ username: "Test", name: "Test", password: "Test" }), null);
  assert.equal((await login("Test")).status, 401);
  assert.equal((await login("a-longer-password")).status, 200);
});
