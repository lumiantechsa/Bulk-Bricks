// Helpers shared by the customer chat and the staff dashboard.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The Bulkbrick pyramid of bricks, from the logo. Inline so the PDF renderer can paint it.
export const logoMarkSvg = (cls = "") => `<svg class="${cls}" viewBox="0 0 100 90" aria-hidden="true"><g fill="none" stroke="#e17639" stroke-width="6">
  <path d="M50 5 96 85H4z" stroke-width="7"/><path d="M37.9 25h24.2M27.6 43h44.8M16.1 63h67.8M57 25v18M33 43v20M57 63v22"/></g></svg>`;

// The logo lock-up for the sidebar and sign-in screen.
const brandMark = `<div class="brand-mark">${logoMarkSvg()}<div><b>Bulkbrick</b><span>Supplies</span></div></div>`;

export const money = (n, currency = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n ?? 0);

export const time = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const statusLabel = {
  draft: "Draft",
  pending_review: "Awaiting approval",
  sent: "Ready",
  accepted: "Accepted",
  rejected: "Declined",
};

export const unitPlural = (unit, n = 2) => (unit === "m²" || n === 1 || unit.endsWith("s") ? unit : `${unit}s`);

// Shows how the job figures were reached: one line per material, then the load.
function workingHtml(d, currency) {
  if (!d) return "";
  const mats = d.materials ?? [d]; // quotes saved before jobs had several materials
  const many = mats.length > 1;
  const matLine = (m) => [
    many ? m.product : null,
    m.size,
    m.coveragePerM2 ? `${m.coveragePerM2}/m² (${m.coverageSource})${m.areaM2 ? ` over ${m.areaM2} m²` : ""}` : null,
    `${m.netQty} ${unitPlural(m.unit)} + ${m.wastageQty} wastage (${m.wastagePercent}%) = ${m.totalQty}`,
    `${m.pallets} pallet${m.pallets === 1 ? "" : "s"} of ${m.unitsPerPallet}${m.partialPallet ? " (last one partial)" : ""}`,
    many ? `${m.weightKg.toLocaleString()} kg` : null,
  ].filter(Boolean);
  const load = [
    many ? `${d.pallets} pallets in total` : null,
    `${d.weightKg.toLocaleString()} kg${many ? " in total" : ""}`,
    d.delivery
      ? `${d.delivery.vehicle}, ${d.delivery.trips} trip${d.delivery.trips === 1 ? "" : "s"}, ${d.delivery.bracket}, ${d.delivery.offloading.toLowerCase()}`
      : "Customer collects",
    d.discount ? `${d.discount.name} discount ${d.discount.percent}% on materials (−${money(d.discount.amount, currency)})` : null,
  ].filter(Boolean);
  const rows = (many ? mats.map(matLine).concat([load]) : [matLine(mats[0]).concat(load)])
    .map((parts) => `<div>${parts.map(esc).join(" · ")}</div>`)
    .join("");
  const notes = (d.notes ?? []).map((n) => `<div class="small note">⚠ ${esc(n)}</div>`).join("");
  return `<div class="muted small working">${rows}</div>${notes}`;
}

export function quoteCardHtml(q, { actions = "", title } = {}) {
  const rows = q.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.name)}${l.volumeDiscountPercent ? ` <span class="muted small">(−${l.volumeDiscountPercent}% volume)</span>` : ""}</td>
        <td class="num">${l.quantity} × ${money(l.unitPrice, q.currency)}<div class="muted small">${esc(l.unit)}</div></td>
        <td class="num">${money(l.lineTotal, q.currency)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="quote-card">
    <h4><span>${esc(title ?? `Quote ${q.number ?? q.id}`)}</span>${q.status ? `<span class="badge ${esc(q.status)}">${esc(statusLabel[q.status] ?? q.status)}</span>` : ""}</h4>
    ${q.projectSummary ? `<div class="muted small">${esc(q.projectSummary)}</div>` : ""}
    ${workingHtml(q.details, q.currency)}
    <table>
      <thead><tr><th>Item</th><th class="num">Qty × price</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tbody class="totals">
        <tr><td colspan="2">Subtotal</td><td class="num">${money(q.subtotal, q.currency)}</td></tr>
        ${q.discount ? `<tr><td colspan="2">Discount (${q.discountPercent}%)</td><td class="num">−${money(q.discount, q.currency)}</td></tr>` : ""}
        <tr><td colspan="2">Tax (${q.taxRatePercent}%)</td><td class="num">${money(q.tax, q.currency)}</td></tr>
        <tr class="grand"><td colspan="2">Total</td><td class="num">${money(q.total, q.currency)}</td></tr>
      </tbody>
    </table>
    ${q.notes ? `<div class="small">${esc(q.notes)}</div>` : ""}
    ${q.validUntil ? `<div class="muted small">Valid until ${esc(q.validUntil)}</div>` : ""}
    ${actions}
  </div>`;
}

// ---------- Staff sign-in, shared by every page ----------
// The session token is a sign-in convenience kept in this browser; all business
// data lives in the database on the server.
const TOKEN_KEY = "pbtStaffSession";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

/** Calls the API as the signed-in employee. Errors carry .status and .body. */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}`, ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/login")) {
    setToken("");
    location.reload();
  }
  if (!res.ok) throw Object.assign(new Error(body.error || "Something went wrong"), { body, status: res.status });
  return body;
}

export const can = (user, permission) => !!user?.permissions?.includes(permission);

/**
 * Shows the sign-in form until the employee signs in; resolves with
 * { user, companyName, currency }.
 */
export async function signIn(root) {
  if (getToken()) {
    try { return await api("/api/auth/me"); } catch { setToken(""); }
  }
  return new Promise((resolve) => {
    const draw = (error = "") => {
      root.innerHTML = `<form class="login panel stack" style="padding:24px" id="login">
        ${brandMark}
        <h2 style="margin:0">Staff sign-in</h2>
        <label>Username<input id="username" autocomplete="username" autofocus required /></label>
        <label>Password<input type="password" id="pw" autocomplete="current-password" required /></label>
        ${error ? `<div class="error" style="padding:0">${esc(error)}</div>` : ""}
        <button class="primary" style="width:100%">Sign in</button>
      </form>`;
      root.querySelector("#login").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          const { token } = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: root.querySelector("#username").value, password: root.querySelector("#pw").value }),
          });
          setToken(token);
          resolve(await api("/api/auth/me"));
        } catch (err) {
          draw(err.message);
        }
      });
    };
    draw();
  });
}

export async function signOut() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  setToken("");
  location.href = "/";
}

/**
 * The left sidebar on every page. `active` is a section key; `extra` is a list
 * of [key, label, badge] for the manager pages in the dashboard.
 */
export function sidebarHtml({ active, user, extra = [] }) {
  const link = (key, href, label, badge) =>
    `<a href="${href}" data-nav="${key}" class="${active === key ? "on" : ""}"><span>${label}</span>${badge ? `<span class="badge pending_review">${badge}</span>` : ""}</a>`;
  return `<aside class="side">
    ${brandMark}
    <nav class="main-nav">
      ${link("assistant", "/", "AI Quoting Assistant")}
      ${link("quotations", "/admin#quotations", "Quotations")}
      ${link("pricing", "/admin#pricing", "Pricing Management")}
    </nav>
    ${extra.length ? `<div class="nav-label">Manage</div><nav class="main-nav">${extra.map(([k, l, b]) => link(k, `/admin#${k}`, l, b)).join("")}</nav>` : ""}
    <div class="side-user">
      <div><b>${esc(user.name)}</b><div class="muted small">${esc(user.roleLabel)}</div></div>
      <div class="row"><a href="/admin#account" class="small">My account</a><button class="small" data-signout>Sign out</button></div>
    </div>
  </aside>`;
}

export function bindSidebar(root) {
  root.querySelector("[data-signout]")?.addEventListener("click", signOut);
}

/**
 * Live change events from the server (product prices, variables, quotations).
 * Uses a streamed fetch so the session token stays in a header. Reconnects.
 */
export function liveUpdates(onEvent, onStatus = () => {}) {
  let stopped = false;
  let retry = 1000;
  (async function connect() {
    while (!stopped) {
      try {
        const res = await fetch("/api/events", { headers: { authorization: `Bearer ${getToken()}` } });
        if (res.status === 401) return;
        if (!res.ok) throw new Error(res.statusText);
        onStatus(true);
        retry = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const p of parts) {
            if (!p.startsWith("data: ")) continue;
            try { onEvent(JSON.parse(p.slice(6))); } catch (err) { console.error(err); }
          }
        }
      } catch {}
      onStatus(false);
      await new Promise((r) => setTimeout(r, retry));
      retry = Math.min(retry * 2, 15000);
    }
  })();
  return () => { stopped = true; };
}

export function toast(msg, kind = "") {
  const el = Object.assign(document.createElement("div"), { className: `toast ${kind}`, textContent: msg });
  // Stack above any toasts still showing.
  const above = [...document.querySelectorAll(".toast")].reduce((h, t) => h + t.offsetHeight + 8, 0);
  el.style.bottom = `${18 + above}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 6000 : 3000);
}

export const statusText = (s) => statusLabel[s] ?? s;
