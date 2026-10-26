// Manager pages: overview, assistant chats (with takeover), employees and
// permissions, the activity log, company settings and the user's own account.
import { can, esc, money, quoteCardHtml, setToken, time } from "/common.js";
import { openDrawer } from "/quotations-page.js";

async function overview(ctx) {
  const { main, api } = ctx;
  const o = await api("/api/admin/overview");
  const convs = can(ctx.user, "supervise_chats") ? (await api("/api/admin/conversations")).slice(0, 8) : [];
  const stat = (v, l) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  main.innerHTML = `<h2>Overview</h2>
    <div class="stats">
      ${stat(o.quotes, "Quotations issued")}
      ${stat(o.drafts, "Drafts in progress")}
      ${stat(o.pendingReview, "Awaiting approval")}
      ${stat(money(o.pipelineValue, o.currency), "Open pipeline")}
      ${stat(money(o.acceptedValue, o.currency), "Accepted value")}
      ${stat(Math.round(o.conversionRate * 100) + "%", "Acceptance rate")}
      ${stat(o.needsHuman, "Chats needing a manager")}
      ${stat(o.activeToday, "Chats active in last 24h")}
    </div>
    ${convs.length ? `<h3>Recent assistant chats</h3><div class="panel table-wrap">${conversationTable(convs, o.currency)}</div>` : ""}`;
  bindConvRows(main, ctx);
  let t;
  return { onEvent(ev) { if (["quotation", "conversation"].includes(ev.type)) { clearTimeout(t); t = setTimeout(() => overview(ctx), 1500); } } };
}

function conversationTable(convs, currency) {
  if (!convs.length) return `<div class="empty">No chats yet.</div>`;
  return `<table class="list"><thead><tr><th>Customer</th><th>Last message</th><th class="num">Quoted</th><th>Status</th><th>Updated</th></tr></thead><tbody>
    ${convs.map((c) => `<tr class="click" data-conv="${esc(c.id)}">
      <td><b>${esc(c.customer?.name || "Customer not named yet")}</b><div class="muted small">${esc(c.customer?.company || c.customer?.email || c.id)}</div></td>
      <td class="small">${esc(c.lastMessage)}</td>
      <td class="num">${c.quoteTotal ? money(c.quoteTotal, currency) : "—"}</td>
      <td><span class="badge ${esc(c.status)}">${esc(c.status.replace("_", " "))}</span>${c.aiPaused ? ` <span class="badge">AI paused</span>` : ""}</td>
      <td class="small muted">${time(c.updatedAt)}</td>
    </tr>`).join("")}
  </tbody></table>`;
}

function bindConvRows(root, ctx) {
  root.querySelectorAll("[data-conv]").forEach((tr) => (tr.onclick = () => ctx.go(`conversations/${tr.dataset.conv}`)));
}

async function conversations(ctx) {
  const { main, api } = ctx;
  if (ctx.args[0]) return conversationDetail(ctx, ctx.args[0]);
  const [convs, me] = await Promise.all([api("/api/admin/conversations"), api("/api/auth/me")]);
  main.innerHTML = `<h2>Assistant chats</h2><div class="panel table-wrap">${conversationTable(convs, me.currency)}</div>`;
  bindConvRows(main, ctx);
  let t;
  return { onEvent(ev) { if (ev.type === "conversation") { clearTimeout(t); t = setTimeout(() => conversations(ctx), 1000); } } };
}

async function conversationDetail(ctx, id) {
  const { main, api } = ctx;
  const c = await api(`/api/admin/conversations/${id}`);
  const msgs = c.transcript.map((t) => {
    if (t.role === "customer") return `<div class="msg customer"><span class="who">${esc(t.by || "Employee")}</span>${esc(t.text)}</div>`;
    if (t.role === "agent") return `<div class="msg agent"><span class="who">AI assistant</span>${esc(t.text)}</div>`;
    if (t.role === "staff") return `<div class="msg staff"><span class="who">${esc(t.author)}</span>${esc(t.text)}</div>`;
    if (t.type === "quote") return `<div class="event">📄 Quote issued · <a href="#quotations/${esc(t.quoteId)}">open</a></div>`;
    if (t.type === "estimate") return `<div class="event">🧱 Job ${t.source === "form" ? "submitted on the form" : "set by the assistant"}: ${money(t.estimate.total, t.estimate.currency)} incl. VAT${t.quotationId ? ` · <a href="#quotations/${esc(t.quotationId)}">${esc(t.number ?? "quotation")}</a>` : ""}</div>`;
    if (t.type === "escalation") return `<div class="event">⚠️ Escalated: ${esc(t.text)}</div>`;
    if (t.type === "quote_status") return `<div class="event">Quote ${esc(t.number ?? t.quoteId)} ${esc(t.text)}</div>`;
    if (t.type === "accepted") return `<div class="event">✅ Customer accepted ${esc(t.number ?? t.quoteId)}</div>`;
    return "";
  }).join("");
  const cust = c.customer || {};
  main.innerHTML = `<div class="row" style="margin-bottom:12px"><a href="#conversations">← All chats</a></div>
    <h2>${esc(cust.name || "Customer not named yet")} <span class="badge ${esc(c.status)}">${esc(c.status.replace("_", " "))}</span></h2>
    <div class="split">
      <div class="stack">
        <div class="messages" id="thread">${msgs}</div>
        <form class="stack" id="reply">
          <textarea name="text" rows="3" placeholder="Reply to the employee as ${esc(ctx.user.name)} (manager)…" required></textarea>
          <div class="row"><button class="primary">Send reply</button></div>
        </form>
      </div>
      <div class="stack">
        <div class="panel" style="padding:14px">
          <div class="small stack">
            <div><b>Customer</b><br>${esc(cust.name || "—")}<br>${esc(cust.company || "")}<br>${cust.email ? `<a href="mailto:${esc(cust.email)}">${esc(cust.email)}</a>` : ""}<br>${esc(cust.phone || "")}</div>
            ${c.escalation ? `<div><b>Escalation (${esc(c.escalation.urgency)})</b><br>${esc(c.escalation.reason)}</div>` : ""}
            <div class="row">
              <button id="pause">${c.aiPaused ? "Resume AI replies" : "Pause AI (take over)"}</button>
              ${c.status === "needs_human" ? `<button id="resolve">Mark resolved</button>` : ""}
              ${c.status !== "closed" ? `<button class="danger" id="close">Close chat</button>` : ""}
            </div>
          </div>
        </div>
        ${c.quotes.map((q) => quoteCardHtml(q, { actions: `<div class="row" style="margin-top:8px"><a href="#quotations/${esc(q.id)}">Open in Quotations</a></div>` })).join("")}
      </div>
    </div>`;
  const thread = main.querySelector("#thread");
  thread.scrollTop = thread.scrollHeight;
  const again = () => conversationDetail(ctx, id);
  const patch = async (body) => { await api(`/api/admin/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) }); again(); };
  main.querySelector("#pause").onclick = () => patch({ aiPaused: !c.aiPaused });
  main.querySelector("#resolve")?.addEventListener("click", () => patch({ status: "active" }));
  main.querySelector("#close")?.addEventListener("click", () => confirm("Close this chat? The employee can't send more messages in it.") && patch({ status: "closed" }));
  main.querySelector("#reply").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/admin/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: new FormData(e.target).get("text") }) });
      again();
    } catch (err) { ctx.toast(err.message, "bad"); }
  };
  return { onEvent(ev) { if (ev.type === "conversation" && ev.id === id && !document.activeElement?.matches("textarea")) again(); } };
}

async function staff(ctx) {
  const { main, api } = ctx;
  const { users, roles, permissions } = await api("/api/staff");
  main.innerHTML = `<div class="page-head"><h2>Employees</h2><button class="primary" id="addUser">+ Add employee</button></div>
    <p class="muted small">Administrators can do everything. Sales employees create, view and edit quotations and generate PDFs; tick extra permissions to authorise more.</p>
    <div class="panel table-wrap"><table class="list"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Extra permissions</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr class="${u.active ? "" : "inactive"}">
        <td><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}</div></td>
        <td>${esc(u.username)}</td>
        <td>${esc(u.roleLabel)}</td>
        <td class="small">${u.role === "admin" ? "All" : u.extraPermissions.map((p) => esc(permissions[p])).join("<br>") || "—"}</td>
        <td>${u.active ? `<span class="badge sent">Active</span>` : `<span class="badge inactive">Disabled</span>`}</td>
        <td><button class="small" data-edit="${esc(u.id)}">Edit</button></td>
      </tr>`).join("")}
    </tbody></table></div>`;

  const form = (u) => `<form id="uform" class="stack" style="padding:14px">
      <div class="form-grid tight">
        <label>Full name<input name="name" value="${esc(u?.name ?? "")}" required /></label>
        <label>Username (for signing in)<input name="username" value="${esc(u?.username ?? "")}" ${u ? "disabled" : "required"} /></label>
        <label>Email<input name="email" type="email" value="${esc(u?.email ?? "")}" /></label>
        <label>Role<select name="role">${Object.entries(roles).map(([k, r]) => `<option value="${k}" ${u?.role === k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></label>
        <label>${u ? "New password (leave empty to keep)" : "Password (at least 8 characters)"}<input name="password" type="password" autocomplete="new-password" ${u ? "" : "required"} /></label>
      </div>
      <fieldset class="panel" style="padding:10px"><legend class="small">Extra permissions for sales employees</legend>
        ${Object.entries(permissions).map(([k, l]) => `<label class="check-row"><input type="checkbox" name="perm" value="${k}" ${u?.extraPermissions.includes(k) ? "checked" : ""}/> ${esc(l)}</label>`).join("")}
      </fieldset>
      ${u ? `<label class="check-row"><input type="checkbox" name="active" ${u.active ? "checked" : ""}/> Can sign in</label>` : ""}
      <div class="row"><button class="primary">${u ? "Save" : "Add employee"}</button><button type="button" id="cancel">Cancel</button></div>
    </form>`;
  const open = (u) => {
    const { panel, close } = openDrawer(`<h3>${u ? esc(u.name) : "Add employee"} <button data-close>✕</button></h3>${form(u)}`);
    panel.querySelector("#cancel").onclick = close;
    panel.querySelector("#uform").onsubmit = async (e) => {
      e.preventDefault();
      const el = e.target.elements;
      const body = {
        name: el.name.value, email: el.email.value, role: el.role.value,
        permissions: [...e.target.querySelectorAll('[name="perm"]:checked')].map((x) => x.value),
        ...(el.password.value && { password: el.password.value }),
        ...(u ? { active: el.active.checked } : { username: el.username.value }),
      };
      try {
        await api(u ? `/api/staff/${u.id}` : "/api/staff", { method: u ? "PUT" : "POST", body: JSON.stringify(body) });
        close();
        ctx.toast(u ? "Employee updated" : "Employee added. Give them their username and password.", "ok");
        staff(ctx);
      } catch (err) { ctx.toast(err.message, "bad"); }
    };
  };
  main.querySelector("#addUser").onclick = () => open(null);
  main.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => open(users.find((u) => u.id === b.dataset.edit))));
}

async function activity(ctx) {
  const { main, api } = ctx;
  const log = await api("/api/audit?limit=300");
  const label = (a) => ({
    "product.create": "Added product", "product.update": "Changed product", "variable.create": "Added pricing variable",
    "variable.update": "Changed pricing variable", "quotation.create": "Created quotation", "quotation.edited": "Edited quotation",
    "quotation.estimate": "Repriced from assistant", "quotation.refreshed": "Refreshed quotation prices", "quotation.issued": "Issued quotation",
    "quotation.status": "Changed quotation status", "quotation.delete": "Deleted quotation", "quotation.restore": "Restored quotation",
    "quotation.pdf": "Generated quotation PDF", "settings.update": "Changed settings", "staff.create": "Added employee",
    "staff.update": "Changed employee", "auth.login": "Signed in",
  })[a] ?? a;
  const detail = (e) => {
    const d = e.details ?? {};
    if (e.action === "product.update") {
      return Object.entries(d.changes ?? {}).map(([k, c]) => `${k}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join("; ");
    }
    if (d.number) return `${d.number}${d.totalAfter !== undefined ? ` (${d.totalBefore} → ${d.totalAfter})` : d.total !== undefined ? ` (${d.total})` : ""}${d.to ? ` → ${d.to}` : ""}`;
    if (d.name) return d.name;
    return JSON.stringify(d).slice(0, 160);
  };
  main.innerHTML = `<h2>Activity log</h2><p class="muted small">Sensitive changes: prices, products, pricing variables, quotations, staff and settings.</p>
    <div class="panel table-wrap"><table class="list"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
      ${log.map((e) => `<tr><td class="small">${time(e.at)}</td><td>${esc(e.user)}</td><td>${esc(label(e.action))}</td><td class="small">${esc(detail(e))}</td></tr>`).join("")}
    </tbody></table></div>`;
}

async function settings(ctx) {
  const { main, api, user } = ctx;
  const s = await api("/api/admin/settings");
  const editable = can(user, "manage_pricing");
  const ro = editable ? "" : "disabled";
  const field = (k, label, type = "text", extra = "") => `<label>${label}<input name="${k}" type="${type}" value="${esc(s[k])}" ${extra} ${ro} /></label>`;
  main.innerHTML = `<h2>Company settings</h2>
    <form class="panel stack" style="padding:18px" id="settings">
      <div class="form-grid">
        ${field("companyName", "Company name")}
        ${field("currency", "Currency (ISO code)", "text", 'maxlength="3"')}
        ${field("quoteValidDays", "Quotes valid for (days)", "number", 'step="1" min="1"')}
      </div>
      <p class="muted small" style="margin:0">VAT, the discount limit and the approval threshold are under Pricing Management → Pricing variables.</p>
      <label>Instructions for the assistant (tone, policies, upsells)
        <textarea name="agentInstructions" rows="5" ${ro}>${esc(s.agentInstructions)}</textarea>
      </label>
      <h3 style="margin:8px 0 0;font-size:15px">Quotation document</h3>
      <div class="form-grid">
        ${field("companyTagline", "Tagline (separate with |)")}
        ${field("companyPhone", "Phone")}
        ${field("companyEmail", "Email")}
        ${field("companyWebsite", "Website")}
        ${field("quotePrefix", "Quote number prefix")}
        ${field("quoteSubtitle", "Heading subtitle")}
        ${field("quoteSignatory", "Signed by (name)")}
        ${field("quoteSignatoryTitle", "Signatory title")}
      </div>
      <label>Company address<textarea name="companyAddress" rows="3" ${ro}>${esc(s.companyAddress)}</textarea></label>
      <label>Terms &amp; notes (one per line; {days} = quote validity)<textarea name="quoteTerms" rows="6" ${ro}>${esc(s.quoteTerms)}</textarea></label>
      <p class="muted small" style="margin:0">Changes apply to new chats. Ongoing chats keep the instructions they started with.</p>
      ${editable ? `<div><button class="primary">Save settings</button></div>` : ""}
    </form>`;
  main.querySelector("#settings").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      ctx.toast("Settings saved", "ok");
    } catch (err) { ctx.toast(err.message, "bad"); }
  };
}

async function account(ctx) {
  const { main, api, user } = ctx;
  main.innerHTML = `<h2>My account</h2>
    <div class="panel stack" style="padding:18px;max-width:520px">
      <div><b>${esc(user.name)}</b> (${esc(user.username)}) · ${esc(user.roleLabel)}</div>
      <div class="small muted">Permissions: ${user.permissions.length ? user.permissions.join(", ").replace(/_/g, " ") : "create and edit quotations"}</div>
      <form id="pw" class="stack">
        <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required /></label>
        <label>New password (at least 8 characters)<input name="newPassword" type="password" autocomplete="new-password" required /></label>
        <div><button class="primary">Change password</button></div>
      </form>
    </div>`;
  main.querySelector("#pw").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { token } = await api("/api/auth/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      setToken(token);
      e.target.reset();
      ctx.toast("Password changed", "ok");
    } catch (err) { ctx.toast(err.message, "bad"); }
  };
}

export const managePages = { overview, conversations, staff, activity, settings, account };
