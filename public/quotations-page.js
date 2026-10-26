// Quotations: every saved quotation as a searchable card, and an editor to
// change it, recalculate, save, regenerate the PDF, refresh prices or delete.
import { can, esc, money, statusText, time } from "/common.js";
import { createJobForm } from "/job-form.js";
import { DOC_WIDTH, downloadQuotePdf, quoteDocHtml } from "/quote-doc.js";

const STATUSES = [["", "All statuses"], ["draft", "Drafts"], ["pending_review", "Awaiting approval"], ["sent", "Ready to send"], ["accepted", "Accepted"], ["rejected", "Declined"]];
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

export const docData = (q, company) => ({
  number: q.status === "draft" ? `${q.number} (DRAFT)` : q.number,
  issued: q.createdAt,
  expires: q.validUntil,
  currency: q.currency,
  customer: q.customer,
  project: { name: q.projectName, site: q.siteAddress, description: q.projectSummary },
  pricing: q,
  notes: q.notes,
  company,
});

function fitDocs(root) {
  for (const scaler of root.querySelectorAll(".doc-scaler")) {
    const doc = scaler.firstElementChild;
    const scale = Math.min(1, scaler.clientWidth / DOC_WIDTH);
    doc.style.transform = `scale(${scale})`;
    scaler.style.height = `${doc.offsetHeight * scale}px`;
  }
}

/** A side panel for dialogs (refresh prices, revisions). Returns the panel element and a close function. */
export function openDrawer(html) {
  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  backdrop.innerHTML = `<div class="drawer" role="dialog" aria-modal="true">${html}</div>`;
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop || e.target.closest("[data-close]")) close(); });
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  return { panel: backdrop.firstElementChild, close };
}

// ---------- Card list ----------

async function listPage(ctx) {
  const { main, api, user } = ctx;
  const canDelete = can(user, "delete_quotations");
  let filters = { search: "", status: "", deleted: false };
  try { filters = { ...filters, ...JSON.parse(sessionStorage.getItem("quoteFilters") || "{}") }; } catch {}
  if (!canDelete) filters.deleted = false;

  main.innerHTML = `<div class="page-head">
      <h2>Quotations</h2>
      <a href="/" class="primary-link"><button class="primary">New quotation in the assistant</button></a>
    </div>
    <div class="toolbar">
      <input type="search" id="search" placeholder="Search by number, customer, company, project or employee" value="${esc(filters.search)}" />
      <select id="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${filters.status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${canDelete ? `<label class="check-row"><input type="checkbox" id="deleted" ${filters.deleted ? "checked" : ""} /> Show deleted</label>` : ""}
    </div>
    <div id="count" class="muted small" style="margin-bottom:8px"></div>
    <div id="cards"><div class="loading">Loading quotations…</div></div>`;

  let flashId = null;
  const load = async () => {
    sessionStorage.setItem("quoteFilters", JSON.stringify(filters));
    const qs = new URLSearchParams({ search: filters.search, status: filters.status, ...(filters.deleted && { deleted: "1" }) });
    let list;
    try {
      list = await api(`/api/quotations?${qs}`);
    } catch (err) {
      main.querySelector("#cards").innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      return;
    }
    main.querySelector("#count").textContent = `${list.length} quotation${list.length === 1 ? "" : "s"}${filters.deleted ? " in the bin" : ""}`;
    main.querySelector("#cards").innerHTML = list.length
      ? `<div class="cards">${list.map((q) => card(q)).join("")}</div>`
      : `<div class="panel empty">${filters.search || filters.status ? "No quotations match." : filters.deleted ? "Nothing has been deleted." : "No quotations yet. Every quotation the assistant prices is saved here automatically."}</div>`;
    if (flashId) main.querySelector(`[data-id="${CSS.escape(flashId)}"]`)?.classList.add("flash");
    flashId = null;
  };
  const card = (q) => `<div class="qcard" data-id="${esc(q.id)}" tabindex="0" role="button" aria-label="Open quotation ${esc(q.number)}">
      <div class="top"><span class="num">${esc(q.number)}</span><span class="badge ${esc(q.status)}">${esc(statusText(q.status))}</span></div>
      <div><b>${esc(q.customer?.company || q.customer?.name || "Customer not named yet")}</b>
        ${q.customer?.company && q.customer?.name ? `<div class="muted small">${esc(q.customer.name)}</div>` : ""}
        ${q.projectName ? `<div class="muted small">${esc(q.projectName)}</div>` : ""}</div>
      <div class="total">${money(q.total, q.currency)}</div>
      <div class="meta">
        <span>Created ${date(q.createdAt)} by ${esc(q.createdByName || "—")}</span>
        <span>Updated ${time(q.updatedAt)}${q.updatedByName && q.updatedByName !== q.createdByName ? ` by ${esc(q.updatedByName)}` : ""}</span>
        ${q.deletedAt ? `<span>Deleted ${time(q.deletedAt)}</span>` : ""}
      </div>
      ${q.deletedAt ? `<div><button class="small" data-restore="${esc(q.id)}">Restore</button></div>` : ""}
    </div>`;

  let timer;
  main.querySelector("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.search = e.target.value; load(); }, 250);
  });
  main.querySelector("#status").addEventListener("change", (e) => { filters.status = e.target.value; load(); });
  main.querySelector("#deleted")?.addEventListener("change", (e) => { filters.deleted = e.target.checked; load(); });
  main.querySelector("#cards").addEventListener("click", async (e) => {
    const restore = e.target.closest("[data-restore]");
    if (restore) {
      e.stopPropagation();
      try {
        await api(`/api/quotations/${restore.dataset.restore}/restore`, { method: "POST" });
        ctx.toast("Quotation restored", "ok");
        load();
      } catch (err) { ctx.toast(err.message, "bad"); }
      return;
    }
    const c = e.target.closest("[data-id]");
    if (c && !filters.deleted) ctx.go(`quotations/${c.dataset.id}`);
  });
  main.querySelector("#cards").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.id && !filters.deleted) ctx.go(`quotations/${e.target.dataset.id}`);
  });
  await load();

  let reload;
  return {
    onEvent(ev) {
      if (ev.type !== "quotation") return;
      flashId = ev.id;
      clearTimeout(reload);
      reload = setTimeout(load, 300);
    },
  };
}

// ---------- Editor ----------

async function editorPage(ctx, id) {
  const { main, api, user } = ctx;
  const [quote, options] = await Promise.all([api(`/api/quotations/${encodeURIComponent(id)}`), api("/api/form-options")]);
  let saved = quote; // last saved version
  let preview = quote; // live recalculation of the edits
  let dirty = false;
  let busy = false;
  let previewError = "";
  let remoteChange = null;
  const overridesAllowed = can(user, "override_prices");
  const approver = can(user, "approve_quotations");
  const locked = () => saved.status === "accepted" && !approver;
  // Editable state outside the job form.
  let edits;
  const resetEdits = () => {
    edits = {
      customer: { ...saved.customer },
      projectName: saved.projectName, siteAddress: saved.siteAddress, projectSummary: saved.projectSummary,
      notes: saved.notes, validUntil: saved.validUntil,
      extras: structuredClone(saved.extras ?? []),
      customLines: structuredClone(saved.customLines ?? []),
      overrides: { ...(saved.overrides ?? {}) },
    };
  };
  resetEdits();

  main.innerHTML = `<div class="row" style="margin-bottom:8px"><a href="#quotations">← All quotations</a></div>
    <div class="page-head">
      <div><h2 id="title"></h2><div class="muted small" id="meta"></div></div>
      <span id="statusBadge"></span>
    </div>
    <div class="editor-actions" id="actions">
      <button class="primary" id="save" disabled>Save changes</button>
      <button id="discard" hidden>Discard changes</button>
      <button id="pdf">Regenerate PDF</button>
      <button id="refresh">Refresh using current prices</button>
      <button id="issue" hidden>Issue quotation</button>
      <button class="primary" id="approve" hidden>Approve</button>
      <button class="danger" id="decline" hidden>Decline</button>
      <button id="accept" hidden>Mark accepted by customer</button>
      <button id="revisions">Revisions</button>
      <button class="danger" id="delete" hidden>Delete</button>
      <span class="muted small" id="saveState"></span>
    </div>
    <div id="banner"></div>
    <div class="editor">
      <aside class="job-panel"><form id="jobForm" class="stack" novalidate><h2>Job</h2><div id="jobFields"></div></form></aside>
      <div class="editor-side">
        <section class="panel stack" style="padding:14px" id="customerBox"></section>
        <section class="panel stack" style="padding:14px" id="extrasBox"></section>
        <section class="panel" style="padding:14px" id="linesBox"></section>
        <section class="panel stack" style="padding:14px">
          <label>Notes on the quotation<textarea id="notes" rows="3"></textarea></label>
          ${saved.staffNote ? `<div class="small"><b>Manager's note:</b> ${esc(saved.staffNote)}</div>` : ""}
        </section>
        <section class="panel stack" style="padding:14px">
          <div class="row" style="justify-content:space-between"><b>Quotation document</b><button type="button" id="togglePreview" class="small">Show preview</button></div>
          <div id="docPreview" hidden></div>
        </section>
      </div>
    </div>`;

  const $ = (sel) => main.querySelector(sel);
  const jobForm = createJobForm($("#jobFields"), { options: options.formOptions, currency: saved.currency, onChange: changed });
  if (saved.job) jobForm.write(saved.job);

  const input = () => ({ ...edits, job: jobForm.read() });

  function renderHeader() {
    $("#title").textContent = `${saved.number}${saved.customer?.company || saved.customer?.name ? ` – ${saved.customer.company || saved.customer.name}` : ""}`;
    $("#statusBadge").innerHTML = `<span class="badge ${esc(saved.status)}">${esc(statusText(saved.status))}</span>`;
    $("#meta").innerHTML = `Created ${time(saved.createdAt)} by ${esc(saved.createdByName || "—")} · Last saved ${time(saved.updatedAt)} by ${esc(saved.updatedByName || "—")} · Revision ${saved.version}
      <br>Prices as saved on ${date(saved.snapshotTakenAt)}. Price-list changes after that don't affect this quotation unless you refresh it.`;
    // The buttons are built once and only shown, hidden or disabled here, so a
    // click is never lost to a re-render (e.g. when a field's change fires on blur).
    const show = (sel, visible) => { const el = $(sel); if (el) el.hidden = !visible; };
    $("#save").disabled = !dirty || busy || locked();
    show("#discard", dirty);
    show("#refresh", !locked());
    show("#issue", saved.status === "draft");
    show("#approve", approver && saved.status === "pending_review");
    show("#decline", approver && saved.status === "pending_review");
    show("#accept", saved.status === "sent");
    show("#delete", can(user, "delete_quotations"));
    $("#saveState").textContent = busy ? "Working…" : dirty ? "Unsaved changes" : "All changes saved";
    const banners = [];
    if (locked()) banners.push(`<div class="notice">This quotation was accepted by the customer, so only a manager can change it.</div>`);
    if (remoteChange) banners.push(`<div class="notice">${esc(remoteChange)} <button class="small" id="loadLatest">Load the latest version</button></div>`);
    if (previewError) banners.push(`<div class="notice bad">${esc(previewError)}</div>`);
    $("#banner").innerHTML = banners.join("");
    $("#loadLatest")?.addEventListener("click", () => reload(true));
    if (locked()) {
      for (const el of main.querySelectorAll(".editor input, .editor select, .editor textarea, .editor button")) {
        if (el.id !== "togglePreview") el.disabled = true;
      }
    }
  }

  function renderCustomer() {
    const c = edits.customer;
    const field = (k, label, type = "text") => `<label>${label}<input data-cust="${k}" type="${type}" value="${esc(c[k] ?? "")}" /></label>`;
    $("#customerBox").innerHTML = `<b>Customer &amp; project</b>
      <div class="form-grid tight">
        ${field("name", "Contact name")}${field("company", "Company")}${field("email", "Email", "email")}${field("phone", "Phone")}
      </div>
      <label>Customer address<input data-cust="address" value="${esc(c.address ?? "")}" /></label>
      <div class="form-grid tight">
        <label>Project name<input data-edit="projectName" value="${esc(edits.projectName)}" /></label>
        <label>Site address<input data-edit="siteAddress" value="${esc(edits.siteAddress)}" /></label>
        <label>Valid until<input data-edit="validUntil" type="date" value="${esc(edits.validUntil ?? "")}" /></label>
      </div>
      <label>Project description<textarea data-edit="projectSummary" rows="2">${esc(edits.projectSummary)}</textarea></label>`;
  }

  function renderExtras() {
    const extras = options.formOptions.extras;
    const known = new Set(extras.map((x) => x.sku));
    const row = (e, i) => `<div class="row" data-extra="${i}">
        <select data-x="sku" style="flex:1;min-width:180px">${known.has(e.sku) ? "" : `<option value="${esc(e.sku)}">${esc(e.sku)} (not on the price list)</option>`}
          ${extras.map((x) => `<option value="${esc(x.sku)}" ${x.sku === e.sku ? "selected" : ""}>${esc(x.name)} – ${money(x.unitPrice, saved.currency)}/${esc(x.unit)}${x.kind === "service" ? " (service)" : ""}</option>`).join("")}
        </select>
        <input data-x="quantity" type="number" min="0" step="any" value="${esc(e.quantity)}" style="width:110px" aria-label="Quantity" />
        <button type="button" class="small" data-remove-extra="${i}">Remove</button>
      </div>`;
    $("#extrasBox").innerHTML = `<div class="row" style="justify-content:space-between"><b>Accessories &amp; services</b>
        <button type="button" class="small" id="addExtra" ${extras.length ? "" : "disabled"}>+ Add item</button></div>
      ${edits.extras.length ? edits.extras.map(row).join("") : `<div class="muted small">None. Add sand, cement, sealer, services and the like.</div>`}`;
  }

  function renderLines() {
    const q = preview;
    const cur = q.currency;
    const rows = q.lines.map((l) => {
      const editable = overridesAllowed && l.code && l.code !== "discount" && !l.code.startsWith("custom:");
      const price = editable
        ? `<input type="number" step="0.01" data-override="${esc(l.code)}" value="${l.unitPrice.toFixed(2)}" aria-label="Unit price for ${esc(l.name)}" />`
        : money(l.unitPrice, cur);
      return `<tr class="${l.overridden ? "overridden" : ""}">
        <td>${esc(l.name)}${l.detail ? `<div class="muted small">${esc(l.detail)}</div>` : ""}
          ${l.overridden && l.listUnitPrice !== undefined ? `<div class="small">Price changed from ${money(l.listUnitPrice, cur)} <button type="button" class="small" data-clear-override="${esc(l.code)}">Undo</button></div>` : ""}</td>
        <td class="num">${l.quantity}<div class="muted small">${esc(l.unit)}</div></td>
        <td class="num">${price}</td>
        <td class="num">${money(l.lineTotal, cur)}</td>
      </tr>`;
    }).join("");
    const manual = edits.customLines.map((c, i) => `<tr data-custom="${i}">
        <td><input data-c="name" value="${esc(c.name)}" placeholder="Description" style="width:100%" /></td>
        <td class="num"><input data-c="quantity" type="number" step="any" min="0" value="${esc(c.quantity)}" /><input data-c="unit" value="${esc(c.unit ?? "")}" placeholder="unit" style="margin-top:4px" /></td>
        <td class="num"><input data-c="unitPrice" type="number" step="0.01" value="${esc(c.unitPrice)}" /></td>
        <td class="num"><button type="button" class="small" data-remove-custom="${i}">Remove</button></td>
      </tr>`).join("");
    $("#linesBox").innerHTML = `<div class="row" style="justify-content:space-between"><b>Line items</b>
        ${overridesAllowed ? `<button type="button" class="small" id="addCustom">+ Manual line</button>` : `<span class="muted small">Ask a manager to change line prices.</span>`}</div>
      <div class="table-wrap"><table class="list lines-table">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        ${manual ? `<tbody><tr><td colspan="4" class="muted small">Manual lines (shown above once recalculated)</td></tr>${manual}</tbody>` : ""}
        <tbody>
          <tr><td colspan="3">Subtotal (excl. VAT)</td><td class="num">${money(q.subtotal, cur)}</td></tr>
          ${q.discount ? `<tr><td colspan="3">Discount (${q.discountPercent}%)</td><td class="num">−${money(q.discount, cur)}</td></tr>` : ""}
          <tr><td colspan="3">VAT (${q.taxRatePercent}%)</td><td class="num">${money(q.tax, cur)}</td></tr>
          <tr><td colspan="3"><b>Total (incl. VAT)</b></td><td class="num"><b>${money(q.total, cur)}</b></td></tr>
        </tbody>
      </table></div>
      ${(q.details?.notes ?? []).map((n) => `<div class="small note" style="color:var(--warn)">⚠ ${esc(n)}</div>`).join("")}`;
  }

  function renderDoc() {
    const box = $("#docPreview");
    if (box.hidden) return;
    box.innerHTML = `<div class="doc-scaler">${quoteDocHtml(docData(saved, options.quoteDocument))}</div>
      <div class="muted small" style="margin-top:6px">This is the last saved version. Save your changes to update it.</div>`;
    fitDocs(box);
  }

  function renderAll() {
    renderCustomer();
    renderExtras();
    renderLines();
    $("#notes").value = edits.notes;
    renderHeader();
    renderDoc();
  }

  // ----- Changes and live recalculation -----
  let previewTimer;
  function changed() {
    if (locked()) return;
    dirty = true;
    renderHeader();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(recalculate, 350);
  }

  async function recalculate() {
    const missing = jobForm.missing();
    if (missing.length) {
      previewError = `Fill in: ${missing.join(", ")}.`;
      return renderHeader();
    }
    try {
      preview = await api(`/api/quotations/${saved.id}/preview`, { method: "POST", body: JSON.stringify({ input: input() }) });
      previewError = "";
    } catch (err) {
      previewError = err.message;
    }
    keepFocus(renderLines);
    renderHeader();
  }

  // Re-rendering the lines mustn't throw the cursor out of the field being typed in.
  function keepFocus(render) {
    const el = document.activeElement;
    const key = el && ["override", "c"].find((k) => el.dataset?.[k] !== undefined);
    const sel = key === "override" ? `[data-override="${CSS.escape(el.dataset.override)}"]`
      : key === "c" ? `[data-custom="${el.closest("[data-custom]").dataset.custom}"] [data-c="${el.dataset.c}"]` : null;
    const caret = sel && el.type === "text" ? el.selectionStart : null;
    render();
    if (!sel) return;
    const again = main.querySelector(sel);
    again?.focus();
    if (again && caret !== null) again.setSelectionRange(caret, caret);
  }

  main.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.cust) edits.customer[t.dataset.cust] = t.value;
    else if (t.dataset.edit) edits[t.dataset.edit] = t.value;
    else if (t.id === "notes") edits.notes = t.value;
    else if (t.dataset.x) {
      const i = Number(t.closest("[data-extra]").dataset.extra);
      edits.extras[i][t.dataset.x] = t.dataset.x === "quantity" ? (t.value === "" ? null : Number(t.value)) : t.value;
    } else if (t.dataset.c) {
      const i = Number(t.closest("[data-custom]").dataset.custom);
      edits.customLines[i][t.dataset.c] = ["quantity", "unitPrice"].includes(t.dataset.c) ? (t.value === "" ? null : Number(t.value)) : t.value;
    } else if (t.dataset.override) {
      if (t.value === "") delete edits.overrides[t.dataset.override];
      else edits.overrides[t.dataset.override] = Number(t.value);
    } else if (!t.closest("#jobFields")) return;
    changed();
  });
  main.addEventListener("change", (e) => { if (e.target.dataset.x === "sku") changed(); });
  main.addEventListener("click", (e) => {
    const t = e.target;
    if (t.id === "addExtra") {
      edits.extras.push({ sku: options.formOptions.extras[0].sku, quantity: 1 });
      renderExtras();
      changed();
    } else if (t.dataset.removeExtra !== undefined) {
      edits.extras.splice(Number(t.dataset.removeExtra), 1);
      renderExtras();
      changed();
    } else if (t.id === "addCustom") {
      edits.customLines.push({ name: "", unit: "", quantity: 1, unitPrice: 0 });
      renderLines();
      changed();
    } else if (t.dataset.removeCustom !== undefined) {
      edits.customLines.splice(Number(t.dataset.removeCustom), 1);
      renderLines();
      changed();
    } else if (t.dataset.clearOverride !== undefined) {
      delete edits.overrides[t.dataset.clearOverride];
      changed();
    } else if (t.id === "togglePreview") {
      const box = $("#docPreview");
      box.hidden = !box.hidden;
      t.textContent = box.hidden ? "Show preview" : "Hide preview";
      renderDoc();
    }
  });
  window.addEventListener("resize", onResize);
  function onResize() { fitDocs(main); }

  // ----- Actions -----
  async function save() {
    const missing = jobForm.missing();
    if (missing.length) { ctx.toast(`Fill in: ${missing.join(", ")}.`, "bad"); return false; }
    busy = true;
    renderHeader();
    try {
      saved = await api(`/api/quotations/${saved.id}`, { method: "PUT", body: JSON.stringify({ version: saved.version, input: input() }) });
      preview = saved;
      dirty = false;
      remoteChange = null;
      resetEdits();
      ctx.toast(`Saved ${saved.number}: ${money(saved.total, saved.currency)}`, "ok");
      return true;
    } catch (err) {
      if (err.status === 409) remoteChange = `${err.message}`;
      ctx.toast(err.message, "bad");
      return false;
    } finally {
      busy = false;
      renderAll();
    }
  }

  async function reload(discard = false) {
    if (dirty && !discard && !confirm("Discard your unsaved changes?")) return;
    saved = preview = await api(`/api/quotations/${saved.id}`);
    dirty = false;
    remoteChange = null;
    previewError = "";
    resetEdits();
    if (saved.job) jobForm.write(saved.job);
    renderAll();
  }

  async function status(action, extra = {}) {
    if (dirty && !(await save())) return;
    try {
      saved = preview = await api(`/api/quotations/${saved.id}/status`, { method: "POST", body: JSON.stringify({ action, version: saved.version, ...extra }) });
      resetEdits();
      ctx.toast(`${saved.number} is now: ${statusText(saved.status)}`, "ok");
      renderAll();
    } catch (err) { ctx.toast(err.message, "bad"); }
  }

  function bindActions() {
    const on = (sel, fn) => $(sel)?.addEventListener("click", fn);
    on("#save", save);
    on("#discard", () => reload());
    on("#issue", () => status("issue"));
    on("#approve", () => status("approve"));
    on("#decline", () => { const note = prompt("Reason for declining (shared with the employee):"); if (note !== null) status("decline", { staffNote: note }); });
    on("#accept", () => status("accept"));
    on("#pdf", async () => {
      if (dirty) {
        if (!confirm("Save your changes first? The PDF is made from the saved quotation.")) return;
        if (!(await save())) return;
      }
      const btn = $("#pdf");
      btn.disabled = true;
      btn.textContent = "Preparing PDF…";
      try {
        const latest = await api(`/api/quotations/${saved.id}`);
        await downloadQuotePdf(docData(latest, options.quoteDocument));
        await api(`/api/quotations/${saved.id}/pdf`, { method: "POST" });
      } catch (err) { ctx.toast(err.message, "bad"); }
      finally { btn.disabled = false; btn.textContent = "Regenerate PDF"; }
    });
    on("#delete", async () => {
      if (!confirm(`Delete ${saved.number}? It moves to the bin, where a manager can restore it.`)) return;
      try {
        await api(`/api/quotations/${saved.id}`, { method: "DELETE" });
        dirty = false;
        ctx.toast(`${saved.number} deleted`, "ok");
        ctx.go("quotations");
      } catch (err) { ctx.toast(err.message, "bad"); }
    });
    on("#refresh", refreshPrices);
    on("#revisions", showRevisions);
  }

  async function refreshPrices() {
    if (dirty && !confirm("Refreshing works on the saved quotation. Save your changes first?")) return;
    if (dirty && !(await save())) return;
    let diff;
    try { diff = await api(`/api/quotations/${saved.id}/compare`); } catch (err) { return ctx.toast(err.message, "bad"); }
    const cur = saved.currency;
    const m = (l) => (l ? `${l.quantity} × ${money(l.unitPrice, cur)} = ${money(l.lineTotal, cur)}` : "—");
    const t = diff.totals.total;
    const cls = t.after > t.before ? "diff-up" : t.after < t.before ? "diff-down" : "";
    const { panel, close } = openDrawer(`<h3>Refresh using current prices <button data-close>✕</button></h3>
      <p class="small muted" style="margin:0">Saved prices are from ${date(diff.snapshotTakenAt)}. This is what changes if ${esc(saved.number)} is repriced with today's price list:</p>
      ${diff.changes.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Line</th><th class="num">Saved</th><th class="num">Current</th></tr></thead><tbody>
        ${diff.changes.map((c) => `<tr><td>${esc(c.name)}</td><td class="num small">${m(c.before)}</td><td class="num small">${m(c.after)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="notice">The prices are the same as the current price list.</div>`}
      <table class="list"><tbody>
        ${["subtotal", "tax", "total"].map((k) => `<tr><td>${{ subtotal: "Subtotal", tax: "VAT", total: "Total" }[k]}</td><td class="num">${money(diff.totals[k].before, cur)}</td><td class="num ${k === "total" ? cls : ""}">${money(diff.totals[k].after, cur)}</td></tr>`).join("")}
      </tbody></table>
      <div class="row"><button class="primary" id="confirmRefresh" ${diff.changes.length ? "" : "disabled"}>Replace saved prices</button><button data-close>Keep saved prices</button></div>`);
    panel.querySelector("#confirmRefresh").addEventListener("click", async () => {
      try {
        saved = preview = await api(`/api/quotations/${saved.id}/refresh`, { method: "POST", body: JSON.stringify({ version: diff.version }) });
        resetEdits();
        if (saved.job) jobForm.write(saved.job);
        dirty = false;
        close();
        ctx.toast(`Repriced: ${money(saved.total, cur)}`, "ok");
        renderAll();
      } catch (err) { ctx.toast(err.message, "bad"); }
    });
  }

  async function showRevisions() {
    const revs = await api(`/api/quotations/${saved.id}/revisions`);
    const label = (a) => ({ created: "Created", estimate: "Repriced from the assistant", customer: "Customer details from the assistant", edited: "Edited", refreshed: "Refreshed with current prices", issued: "Issued" })[a] ?? (a.startsWith("status:") ? `Status: ${statusText(a.slice(7))}` : a);
    const { panel } = openDrawer(`<h3>Revisions of ${esc(saved.number)} <button data-close>✕</button></h3>
      <table class="list"><thead><tr><th>#</th><th>Change</th><th>By</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${revs.map((r) => `<tr><td>${r.revision}</td><td>${esc(label(r.action))}${r.summary ? `<div class="muted small">${esc(r.summary)}</div>` : ""}<div class="muted small">${time(r.at)}</div></td>
        <td>${esc(r.changedBy || "—")}</td><td class="num">${money(r.total, saved.currency)}</td><td><button class="small" data-rev="${r.revision}">View</button></td></tr>`).join("")}
      </tbody></table><div id="revDoc"></div>`);
    panel.addEventListener("click", async (e) => {
      const rev = e.target.dataset.rev;
      if (!rev) return;
      const snap = await api(`/api/quotations/${saved.id}/revisions/${rev}`);
      panel.querySelector("#revDoc").innerHTML = `<p class="small"><b>Revision ${rev}</b> as it was saved:</p><div class="doc-scaler">${quoteDocHtml(docData(snap, options.quoteDocument))}</div>`;
      fitDocs(panel);
    });
  }

  bindActions();
  renderAll();

  let optionsTimer;
  return {
    canLeave: (silent) => !dirty || (!silent && confirm("You have unsaved changes on this quotation. Leave without saving?")),
    cleanup: () => window.removeEventListener("resize", onResize),
    async onEvent(ev) {
      // Our own saves come back as events too; the save response already updated the page.
      if (ev.type === "quotation" && ev.id === saved.id && ev.by !== user.id) {
        if (ev.action === "deleted") {
          remoteChange = "This quotation was deleted by someone else.";
          return renderHeader();
        }
        if ((ev.version ?? 0) <= saved.version) return;
        if (!dirty) {
          await reload(true);
          ctx.toast("This quotation was updated by someone else; showing their version.");
        } else {
          remoteChange = "Someone else saved this quotation while you were editing. Saving now will be refused so their work isn't lost.";
          renderHeader();
        }
      }
      if (["product", "variable"].includes(ev.type)) {
        clearTimeout(optionsTimer);
        optionsTimer = setTimeout(async () => {
          const next = await api("/api/form-options");
          options.formOptions = next.formOptions;
          if (!locked()) jobForm.setOptions(next.formOptions);
          renderExtras();
        }, 300);
      }
    },
  };
}

export const quotationsPage = {
  quotations(ctx) {
    return ctx.args[0] ? editorPage(ctx, ctx.args[0]) : listPage(ctx);
  },
};
