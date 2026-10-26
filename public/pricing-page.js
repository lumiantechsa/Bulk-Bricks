// Pricing Management: the product catalogue, AI-assisted product entry,
// price history and the pricing variables the calculator uses. Everyone can
// look; only staff with the "manage pricing" permission can change anything
// (the server enforces this too).
import { can, esc, money, time } from "/common.js";
import { openDrawer } from "/quotations-page.js";

const VAT_LABELS = { standard: "Standard VAT", zero_rated: "Zero-rated", exempt: "Exempt" };
const DELIVERY_LABELS = { none: "No special requirement", forklift: "Needs forklift (or crane) offloading", crane: "Needs crane offloading" };

async function pricing(ctx) {
  const { main, api, user } = ctx;
  const manage = can(user, "manage_pricing");
  const tab = ctx.args[0] === "variables" ? "variables" : "products";
  let data = await api("/api/catalog");
  const cur = data.settings.currency;
  const catName = (k) => data.categories.find((c) => c.key === k)?.name ?? k;
  const catKind = (k) => data.categories.find((c) => c.key === k)?.kind;
  let filters = { search: "", category: "", inactive: true };
  let openProduct = null; // { id, version, onRemote } while a product drawer is open

  main.innerHTML = `<div class="page-head"><h2>Pricing Management</h2>
      <div class="row">${manage ? `<button id="aiAdd">✨ Add product with AI</button><button class="primary" id="add">+ Add product</button>` : ""}</div></div>
    ${manage ? "" : `<div class="notice" style="margin-bottom:12px">You can view the approved price list. Changing prices needs the "manage pricing" permission.</div>`}
    <div class="tabs"><button data-tab="products" class="${tab === "products" ? "on" : ""}">Products</button><button data-tab="variables" class="${tab === "variables" ? "on" : ""}">Pricing variables</button></div>
    <div id="body"></div>`;
  main.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => ctx.go(b.dataset.tab === "products" ? "pricing" : "pricing/variables")));
  const body = main.querySelector("#body");

  // ---------- Products ----------
  function renderProducts() {
    if (!body.querySelector("#ptable")) {
      body.innerHTML = `<div class="toolbar">
          <input type="search" id="psearch" placeholder="Search by name, code or description" value="${esc(filters.search)}" />
          <select id="pcat"><option value="">All categories</option>${data.categories.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join("")}</select>
          ${manage ? `<label class="check-row"><input type="checkbox" id="pinactive" ${filters.inactive ? "checked" : ""}/> Show inactive</label>` : ""}
        </div>
        <div class="panel table-wrap"><table class="list" id="ptable"><thead><tr>
          <th>Product</th><th>Category</th><th class="num">Price (excl. VAT)</th><th>Pallet</th><th>Size</th><th>Status</th><th>Updated</th>
        </tr></thead><tbody></tbody></table></div>`;
      body.querySelector("#pcat").value = filters.category;
      let t;
      body.querySelector("#psearch").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { filters.search = e.target.value; renderProducts(); }, 150); });
      body.querySelector("#pcat").addEventListener("change", (e) => { filters.category = e.target.value; renderProducts(); });
      body.querySelector("#pinactive")?.addEventListener("change", (e) => { filters.inactive = e.target.checked; renderProducts(); });
      body.querySelector("#ptable tbody").addEventListener("click", (e) => {
        const tr = e.target.closest("[data-pid]");
        if (tr) productDrawer(data.products.find((p) => p.id === tr.dataset.pid));
      });
    }
    const s = filters.search.trim().toLowerCase();
    const list = data.products.filter((p) =>
      (!filters.category || p.category === filters.category) && (filters.inactive || p.active) &&
      (!s || `${p.name} ${p.sku} ${p.description}`.toLowerCase().includes(s)));
    const size = (p) => (p.lengthMm ? `${p.lengthMm} × ${p.widthMm} × ${p.heightMm} mm` : "—");
    body.querySelector("#ptable tbody").innerHTML = list.length ? list.map((p) => `<tr class="click ${p.active ? "" : "inactive"}" data-pid="${esc(p.id)}">
        <td><b>${esc(p.name)}</b><div class="muted small">${esc(p.sku)}${p.colour ? ` · ${esc(p.colour)}` : ""}</div></td>
        <td class="small">${esc(catName(p.category))}</td>
        <td class="num"><b>${money(p.unitPrice, cur)}</b><div class="muted small">per ${esc(p.unit)}${p.vatTreatment !== "standard" ? ` · ${VAT_LABELS[p.vatTreatment]}` : ""}</div></td>
        <td class="small">${p.unitsPerPallet ? `${p.unitsPerPallet} / pallet` : "—"}</td>
        <td class="small">${size(p)}</td>
        <td>${p.active ? `<span class="badge sent">Active</span>` : `<span class="badge inactive">Inactive</span>`}</td>
        <td class="small muted">${time(p.updatedAt)}${p.updatedBy ? `<div>${esc(p.updatedBy)}</div>` : ""}</td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty">No products match.</td></tr>`;
  }

  // The product form, with fields shown according to the category's kind.
  function productFormHtml(p, missing = []) {
    const miss = new Set(missing);
    const ro = manage ? "" : "disabled";
    const inp = (k, label, type = "text", extra = "") =>
      `<label class="${miss.has(k) ? "missing" : ""}" data-for="${k}">${label}<input name="${k}" type="${type}" value="${esc(p[k] ?? "")}" ${extra} ${ro} /></label>`;
    const sel = (k, label, opts) =>
      `<label data-for="${k}">${label}<select name="${k}" ${ro}>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(p[k] ?? "") === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
    return `<form id="pform" class="stack" novalidate>
      <div class="form-grid tight">
        ${inp("name", "Product name *")}
        <label class="${miss.has("category") ? "missing" : ""}">Category *<select name="category" ${ro}>${["", ...data.categories.map((c) => c.key)].map((k) => `<option value="${esc(k)}" ${p.category === k ? "selected" : ""}>${k ? esc(catName(k)) : "Choose…"}</option>`).join("")}</select></label>
        ${inp("sku", "Product code / SKU", "text", 'placeholder="Made from the name if empty"')}
      </div>
      <label>Description<textarea name="description" rows="2" ${ro}>${esc(p.description ?? "")}</textarea></label>
      <div class="form-grid tight">
        <label class="${miss.has("unit") ? "missing" : ""}" data-unit>Unit of measurement *<input name="unit" list="unitList" value="${esc(p.unit ?? "")}" ${ro} />
          <datalist id="unitList">${data.schema.materialUnits.map((u) => `<option value="${esc(u)}">`).join("")}<option value="bag"><option value="m³"><option value="hour"><option value="trip"><option value="job"></datalist></label>
        ${inp("unitPrice", `Unit selling price (${cur}, excl. VAT) *`, "number", 'step="0.01" min="0"')}
        ${sel("vatTreatment", "VAT treatment", Object.entries(VAT_LABELS))}
      </div>
      <fieldset class="panel stack" style="padding:12px" data-kind="material"><legend class="small"><b>Material details</b></legend>
        <div class="form-grid tight">
          ${inp("lengthMm", "Length (mm)", "number", 'step="1" min="1"')}${inp("widthMm", "Width (mm)", "number", 'step="1" min="1"')}${inp("heightMm", "Height (mm)", "number", 'step="1" min="1"')}
        </div>
        <label class="check-row"><input type="checkbox" name="sizeVerified" ${p.sizeVerified ? "checked" : ""} ${ro}/> Size confirmed from the product information</label>
        <div class="form-grid tight">
          ${inp("unitsPerPallet", "Units per pallet *", "number", 'step="any" min="0"')}
          ${inp("weightKg", "Weight per unit (kg) *", "number", 'step="any" min="0"')}
          ${inp("coveragePerM2", "Coverage (units per m²)", "number", 'step="any" min="0" placeholder="From size if empty"')}
          ${sel("layout", "Laid as", [["", "Not laid by area"], ["wall", "Wall (length × height)"], ["paving", "Paving (length × width)"]])}
          ${inp("defaultWastagePercent", "Default wastage %", "number", 'step="0.5" min="0" max="30"')}
          ${sel("deliveryRequirement", "Delivery requirement", Object.entries(DELIVERY_LABELS))}
        </div>
        <div class="form-grid tight">
          ${inp("colour", "Colour (part of the product)")}${inp("finish", "Finish (part of the product)")}
          <label>Colour choices (keys, comma separated)<input name="colourOptions" value="${esc((p.colourOptions ?? []).join(", "))}" ${ro} placeholder="${esc(data.variables.filter((v) => v.kind === "colour").map((v) => v.id.slice(7)).slice(0, 4).join(", "))}" /></label>
          <label>Finish choices (keys, comma separated)<input name="finishOptions" value="${esc((p.finishOptions ?? []).join(", "))}" ${ro} /></label>
        </div>
        <div class="form-grid tight">
          ${sel("labourBasis", "Labour charged per", [["area", "m² laid"], ["quantity", "unit sold"]])}
          ${inp("labourRate", `Installation labour rate (${cur})`, "number", 'step="0.01" min="0" placeholder="Leave empty if not installed"')}
        </div>
      </fieldset>
      <fieldset class="panel stack" style="padding:12px" data-kind="extra"><legend class="small"><b>Sold as an extra</b></legend>
        <div class="form-grid tight">
          ${inp("minQuantity", "Minimum quantity", "number", 'step="any" min="0"')}
          <label>Volume discounts (qty:%, e.g. 10:5, 40:8)<input name="volumeTiers" value="${esc((p.volumeTiers ?? []).map((t) => `${t.minQuantity}:${t.discountPercent}`).join(", "))}" ${ro} /></label>
        </div>
      </fieldset>
      <label class="check-row"><input type="checkbox" name="active" ${p.active === false ? "" : "checked"} ${ro}/> Active (available in new quotations)</label>
    </form>`;
  }

  function bindKindToggle(panel) {
    const form = panel.querySelector("#pform");
    const update = () => {
      const kind = catKind(form.elements.category.value);
      form.querySelector('[data-kind="material"]').hidden = kind && kind !== "material";
      form.querySelector('[data-kind="extra"]').hidden = kind === "material" || !kind;
    };
    form.elements.category.addEventListener("change", update);
    update();
  }

  function readProductForm(form) {
    const e = form.elements;
    const n = (k) => (e[k].value === "" ? null : Number(e[k].value));
    const kind = catKind(e.category.value);
    const tiers = e.volumeTiers.value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [minQuantity, discountPercent] = s.split(":").map(Number);
      return { minQuantity, discountPercent };
    });
    return {
      name: e.name.value.trim(), category: e.category.value, sku: e.sku.value.trim(), description: e.description.value.trim(),
      unit: e.unit.value.trim(), unitPrice: n("unitPrice"), vatTreatment: e.vatTreatment.value,
      ...(kind === "material"
        ? {
          lengthMm: n("lengthMm"), widthMm: n("widthMm"), heightMm: n("heightMm"), sizeVerified: e.sizeVerified.checked,
          unitsPerPallet: n("unitsPerPallet"), weightKg: n("weightKg"), coveragePerM2: n("coveragePerM2"), layout: e.layout.value || null,
          defaultWastagePercent: n("defaultWastagePercent"), deliveryRequirement: e.deliveryRequirement.value,
          colour: e.colour.value.trim() || null, finish: e.finish.value.trim() || null,
          colourOptions: e.colourOptions.value, finishOptions: e.finishOptions.value,
          labourBasis: e.labourBasis.value, labourRate: n("labourRate"),
        }
        : { minQuantity: n("minQuantity"), volumeTiers: tiers }),
      active: e.active.checked,
    };
  }

  async function productDrawer(p, { draft = null, missing = [], notes = "" } = {}) {
    const isNew = !p;
    const product = p ?? { active: true, vatTreatment: "standard", deliveryRequirement: "none", labourBasis: "area", ...(draft ?? {}) };
    const { panel, close } = openDrawer(`<h3>${isNew ? "Add product" : esc(product.name)} <button data-close>✕</button></h3>
      <div id="pnote">${notes}</div>
      <div id="pconflict"></div>
      ${productFormHtml(product, missing)}
      ${manage ? `<div class="row"><button class="primary" id="psave">${isNew ? "Save product" : "Save changes"}</button><button data-close>Cancel</button></div>` : ""}
      ${isNew ? "" : `<div><b>Price history</b><div id="phistory" class="history muted">Loading…</div></div>`}`);
    bindKindToggle(panel);
    openProduct = isNew ? null : { id: product.id, version: product.version };
    const markMissing = (keys) => {
      panel.querySelectorAll(".missing").forEach((el) => el.classList.remove("missing"));
      for (const k of keys) panel.querySelector(`[name="${k}"]`)?.closest("label")?.classList.add("missing");
    };
    panel.querySelector("#psave")?.addEventListener("click", async () => {
      const form = panel.querySelector("#pform");
      const values = readProductForm(form);
      const required = ["name", "category", "unit", "unitPrice", ...(catKind(values.category) === "material" ? ["unitsPerPallet", "weightKg"] : [])];
      const empty = required.filter((k) => values[k] === null || values[k] === "");
      if (empty.length) {
        markMissing(empty);
        return ctx.toast("Fill in the highlighted fields before saving.", "bad");
      }
      const btn = panel.querySelector("#psave");
      btn.disabled = true;
      btn.textContent = "Saving…";
      try {
        const savedProduct = isNew
          ? await api("/api/products", { method: "POST", body: JSON.stringify({ ...values, via: draft ? "ai" : "form" }) })
          : await api(`/api/products/${product.id}`, { method: "PUT", body: JSON.stringify({ ...values, version: product.version }) });
        close();
        openProduct = null;
        ctx.toast(isNew
          ? `${savedProduct.name} added. It's in the quoting assistant for everyone now.`
          : `Saved. Everyone now sees ${savedProduct.name} at ${money(savedProduct.unitPrice, cur)} per ${savedProduct.unit}.`, "ok");
        await reload();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = isNew ? "Save product" : "Save changes";
        if (err.status === 409 && err.body?.current) {
          panel.querySelector("#pconflict").innerHTML = `<div class="notice bad">${esc(err.message)} Current price: ${money(err.body.current.unitPrice, cur)}, saved by ${esc(err.body.current.updatedBy ?? "someone")}. <button class="small" id="reopen">Load their version</button></div>`;
          panel.querySelector("#reopen").addEventListener("click", () => { close(); productDrawer(err.body.current); });
        } else {
          ctx.toast(err.message, "bad");
        }
      }
    });
    if (!isNew) {
      const history = await api(`/api/products/${product.id}/history`);
      const label = { unit_price: "Price", labour_rate: "Labour rate" };
      panel.querySelector("#phistory").innerHTML = history.length
        ? `<table class="list"><thead><tr><th>When</th><th>What</th><th class="num">From</th><th class="num">To</th><th>By</th></tr></thead><tbody>
          ${history.map((h) => `<tr><td>${time(h.changedAt)}</td><td>${label[h.field] ?? h.field}</td><td class="num">${h.oldValue === null ? "—" : money(h.oldValue, cur)}</td><td class="num">${h.newValue === null ? "—" : money(h.newValue, cur)}</td><td>${esc(h.changedBy || "—")}</td></tr>`).join("")}</tbody></table>`
        : "No price changes recorded.";
    }
    openProduct && (openProduct.panel = panel);
  }

  function aiDrawer() {
    const { panel, close } = openDrawer(`<h3>Add a product with AI <button data-close>✕</button></h3>
      <div class="ai-box">
        <label>Describe the product in your own words
          <textarea id="aitext" rows="4" placeholder="e.g. Add a new charcoal paving brick, 200 by 100 by 50 millimetres, costing R7.50 each, with 500 bricks per pallet, 2.3 kg each."></textarea></label>
        <div class="muted small">The assistant only fills in what you state. It never makes up prices, sizes or quantities; anything missing is highlighted for you to add. Nothing is saved until you check it and press Save.</div>
        <div><button class="primary" id="extract">Read description</button></div>
      </div>`);
    panel.querySelector("#extract").addEventListener("click", async () => {
      const btn = panel.querySelector("#extract");
      const text = panel.querySelector("#aitext").value.trim();
      if (!text) return ctx.toast("Describe the product first.", "bad");
      btn.disabled = true;
      btn.textContent = "Reading…";
      try {
        const r = await api("/api/products/extract", { method: "POST", body: JSON.stringify({ text }) });
        close();
        const labels = { unitPrice: "price", lengthMm: "length", widthMm: "width", heightMm: "height", unitsPerPallet: "units per pallet", weightKg: "weight", coveragePerM2: "coverage", labourRate: "labour rate", defaultWastagePercent: "wastage", minQuantity: "minimum quantity" };
        const notes = [
          `<div class="notice">Check the details the assistant found${r.draft.category ? ` (category: ${esc(catName(r.draft.category))})` : ""}, complete anything highlighted, then save.</div>`,
          r.missing.length ? `<div class="notice bad">Still needed before saving: ${r.missing.map((m) => esc(m.label)).join(", ")}.</div>` : "",
          r.unconfirmed.length ? `<div class="notice">Left empty because the figure isn't in your description: ${r.unconfirmed.map((k) => esc(labels[k] ?? k)).join(", ")}.</div>` : "",
          r.questions.length ? `<div class="notice">The assistant asks: ${r.questions.map(esc).join(" · ")}</div>` : "",
        ].join("");
        productDrawer(null, { draft: r.draft, missing: r.missing.map((m) => m.key), notes });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Read description";
        ctx.toast(err.message, "bad");
      }
    });
  }

  // ---------- Pricing variables ----------
  function variableValue(v) {
    const kinds = data.schema.variableKinds;
    if (v.kind === "rate") return v.dataType === "currency" ? money(v.value, cur) : `${v.value}`;
    if (v.kind === "adjustment") return v.dataType === "percent" ? `${v.value}%` : v.dataType === "currency" ? money(v.value, cur) : `${v.value}`;
    return kinds[v.kind].fields.map((f) => {
      const x = v.fields[f.key];
      if (f.type === "boolean") return x ? f.label : null;
      if (x === null || x === undefined) return `${f.label}: —`;
      return `${f.label}: ${f.type === "currency" ? money(x, cur) : x}`;
    }).filter(Boolean).join(" · ");
  }

  function renderVariables() {
    const kinds = data.schema.variableKinds;
    const groupOf = (v) => (v.kind === "rate" ? data.schema.ratePaths[v.id.slice(5)]?.group : kinds[v.kind]?.group) ?? "Other";
    const groups = {};
    for (const v of data.variables) (groups[groupOf(v)] ??= []).push(v);
    const order = ["Delivery", "Offloading & site", "Pallets & packaging", "Labour & installation", "Discounts", "Colours & finishes", "Wastage", "Custom adjustments", "General rates"];
    const rulesText = data.schema.adjustmentRules;
    body.innerHTML = `${manage ? `<div class="toolbar"><button class="primary" id="addVar">+ Add pricing variable</button>
        <span class="muted small">Variables feed the quotation calculator through fixed, validated rules. No formulas are run.</span></div>` : ""}
      <section class="panel stack" style="padding:14px;margin-bottom:14px"><b>Quotation limits</b>
        <form id="limits" class="form-grid tight">
          <label>VAT rate %<input name="taxRatePercent" type="number" step="0.01" min="0" max="100" value="${data.settings.taxRatePercent}" ${manage ? "" : "disabled"} /></label>
          <label>Maximum negotiated discount %<input name="maxDiscountPercent" type="number" step="0.5" min="0" max="100" value="${data.settings.maxDiscountPercent}" ${manage ? "" : "disabled"} /></label>
          <label>Quotes above this need approval (${cur})<input name="autoApproveLimit" type="number" step="1" min="0" value="${data.settings.autoApproveLimit}" ${manage ? "" : "disabled"} /></label>
          ${manage ? `<div style="align-self:end"><button class="primary">Save limits</button></div>` : ""}
        </form></section>
      ${order.filter((g) => groups[g]).concat(Object.keys(groups).filter((g) => !order.includes(g))).map((g) => `<h3 style="margin:18px 0 8px;font-size:15px">${esc(g)}</h3>
        <div class="panel table-wrap"><table class="list"><thead><tr><th>Name</th><th>Value</th><th>Applies to</th><th>Status</th><th>Updated</th></tr></thead><tbody>
        ${groups[g].map((v) => `<tr class="click ${v.active ? "" : "inactive"}" data-vid="${esc(v.id)}">
          <td><b>${esc(v.name)}</b><div class="muted small">${esc(kinds[v.kind]?.label ?? v.kind)}${v.description ? ` · ${esc(v.description)}` : ""}</div></td>
          <td class="small">${esc(variableValue(v))}${v.unit ? ` <span class="muted">${esc(v.unit)}</span>` : ""}${v.rule ? `<div class="muted">${esc(rulesText[v.rule] ?? v.rule)}</div>` : ""}</td>
          <td class="small">${v.kind === "adjustment" ? (v.categories.length ? v.categories.map((c) => esc(catName(c))).join(", ") : "All products") : "—"}</td>
          <td>${v.active ? `<span class="badge sent">Active</span>` : `<span class="badge inactive">Inactive</span>`}</td>
          <td class="small muted">${time(v.updatedAt)}${v.updatedBy ? `<div>${esc(v.updatedBy)}</div>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>`).join("")}`;
    body.querySelector("#addVar")?.addEventListener("click", () => variableDrawer(null));
    body.querySelectorAll("[data-vid]").forEach((tr) => tr.addEventListener("click", () => variableDrawer(data.variables.find((v) => v.id === tr.dataset.vid))));
    body.querySelector("#limits").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
        ctx.toast("Limits saved", "ok");
        await reload();
      } catch (err) { ctx.toast(err.message, "bad"); }
    });
  }

  function variableDrawer(v) {
    const kinds = data.schema.variableKinds;
    const isNew = !v;
    const ro = manage ? "" : "disabled";
    const kindChoices = Object.entries(kinds).filter(([k]) => k !== "rate");
    const fieldsHtml = (kind, src) => {
      if (kind === "rate") {
        return `<label>Value${src.unit ? ` (${esc(src.unit)})` : ""}<input name="value" type="number" step="any" min="0" value="${esc(src.value ?? "")}" ${ro} /></label>`;
      }
      if (kind === "adjustment") {
        return `<div class="form-grid tight">
            <label>Data type<select name="data_type" ${ro}>${[["currency", "Amount (" + cur + ")"], ["percent", "Percentage"], ["number", "Number"]].map(([k, l]) => `<option value="${k}" ${src.dataType === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
            <label>Value<input name="value" type="number" step="any" value="${esc(src.value ?? "")}" ${ro} /></label>
            <label>Unit (label)<input name="unit" value="${esc(src.unit ?? "")}" placeholder="e.g. per brick" ${ro} /></label>
          </div>
          <label>How it's charged<select name="rule" ${ro}>${Object.entries(data.schema.adjustmentRules).map(([k, l]) => `<option value="${k}" ${src.rule === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
          <fieldset class="panel" style="padding:10px"><legend class="small">Applies to product categories (none ticked = all)</legend>
            <div class="form-grid tight">${data.categories.filter((c) => c.kind === "material").map((c) => `<label class="check-row"><input type="checkbox" name="cat" value="${esc(c.key)}" ${(src.categories ?? []).includes(c.key) ? "checked" : ""} ${ro}/> ${esc(c.name)}</label>`).join("")}</div>
          </fieldset>`;
      }
      return `<div class="form-grid tight">${kinds[kind].fields.map((f) => f.type === "boolean"
        ? `<label class="check-row"><input type="checkbox" name="f_${f.key}" ${src.fields?.[f.key] ? "checked" : ""} ${ro}/> ${esc(f.label)}</label>`
        : `<label>${esc(f.label)}${f.type === "currency" ? ` (${cur})` : ""}<input name="f_${f.key}" type="number" step="any" value="${esc(src.fields?.[f.key] ?? "")}" ${ro} /></label>`).join("")}</div>`;
    };
    const { panel, close } = openDrawer(`<h3>${isNew ? "Add pricing variable" : esc(v.name)} <button data-close>✕</button></h3>
      <div id="vconflict"></div>
      <form id="vform" class="stack" novalidate>
        ${isNew ? `<label>Type<select name="kind">${kindChoices.map(([k, d]) => `<option value="${k}" ${k === "adjustment" ? "selected" : ""}>${esc(d.label)} (${esc(d.group)})</option>`).join("")}</select></label>` : `<div class="muted small">${esc(kinds[v.kind]?.label ?? v.kind)}</div>`}
        <label>Name<input name="name" value="${esc(v?.name ?? "")}" ${v?.kind === "rate" ? "disabled" : ro} /></label>
        <div id="vfields">${fieldsHtml(v?.kind ?? "adjustment", v ?? { dataType: "currency", rule: "per_unit" })}</div>
        <label>Description<input name="description" value="${esc(v?.description ?? "")}" ${ro} /></label>
        ${v?.kind === "rate" ? "" : `<label class="check-row"><input type="checkbox" name="active" ${v?.active === false ? "" : "checked"} ${ro}/> Active</label>`}
      </form>
      ${manage ? `<div class="row"><button class="primary" id="vsave">${isNew ? "Add variable" : "Save changes"}</button><button data-close>Cancel</button></div>` : ""}`);
    const form = panel.querySelector("#vform");
    form.elements.kind?.addEventListener("change", (e) => {
      panel.querySelector("#vfields").innerHTML = fieldsHtml(e.target.value, { dataType: "currency", rule: "per_unit", fields: {} });
    });
    panel.querySelector("#vsave")?.addEventListener("click", async () => {
      const e = form.elements;
      const kind = v?.kind ?? e.kind.value;
      const payload = { name: e.name.value.trim(), description: e.description.value.trim() };
      if (e.active) payload.active = e.active.checked;
      if (kind === "rate") payload.value = e.value.value === "" ? null : Number(e.value.value);
      else if (kind === "adjustment") {
        Object.assign(payload, {
          data_type: e.data_type.value, value: e.value.value === "" ? null : Number(e.value.value), unit: e.unit.value.trim(), rule: e.rule.value,
          categories: [...form.querySelectorAll('[name="cat"]:checked')].map((c) => c.value),
        });
      } else {
        payload.fields = Object.fromEntries(kinds[kind].fields.map((f) => {
          const el = e[`f_${f.key}`];
          return [f.key, f.type === "boolean" ? el.checked : el.value === "" ? null : Number(el.value)];
        }));
      }
      try {
        if (isNew) await api("/api/pricing-variables", { method: "POST", body: JSON.stringify({ kind, ...payload }) });
        else await api(`/api/pricing-variables/${encodeURIComponent(v.id)}`, { method: "PUT", body: JSON.stringify({ ...payload, version: v.version }) });
        close();
        ctx.toast(`${payload.name || v.name} saved. New quotations use it straight away.`, "ok");
        await reload();
      } catch (err) {
        if (err.status === 409) {
          panel.querySelector("#vconflict").innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
        } else ctx.toast(err.message, "bad");
      }
    });
  }

  async function reload() {
    data = await api("/api/catalog");
    tab === "products" ? renderProducts() : renderVariables();
  }

  main.querySelector("#add")?.addEventListener("click", () => productDrawer(null));
  main.querySelector("#aiAdd")?.addEventListener("click", aiDrawer);
  tab === "products" ? renderProducts() : renderVariables();

  let timer;
  return {
    onEvent(ev) {
      if (!["product", "variable", "settings"].includes(ev.type)) return;
      if (ev.type === "product" && openProduct?.id === ev.id && ev.version > openProduct.version && ev.by !== user.id) {
        const box = openProduct.panel?.querySelector("#pconflict");
        if (box) box.innerHTML = `<div class="notice">Someone else just saved this product. Saving your version will be refused; close and reopen it to see their changes.</div>`;
      }
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    },
  };
}

export const pricingPage = { pricing };
