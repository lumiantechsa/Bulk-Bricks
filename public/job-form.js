// The job form (materials plus delivery, pallets, labour and discount), used by
// the quoting assistant and the quotation editor. Options come from the live
// price list (/api/form-options), so new products appear without a code change.
import { esc, money } from "/common.js";

const MATERIAL_FIELDS = ["productKey", "colour", "finish", "useCustomSize", "lengthMm", "widthMm", "heightMm", "quantityMode", "quantity", "wastagePercent"];
const MAX_MATERIALS = 12;

const FORM_HTML = `
  <fieldset>
    <legend>Materials</legend>
    <p class="muted small" style="margin:0">Add every product the job needs. Each material has its own colour, size, quantity and wastage.</p>
    <div data-materials class="materials"></div>
    <button type="button" data-add-material>+ Add material</button>
  </fieldset>
  <fieldset>
    <legend>Pallets &amp; packaging</legend>
    <label class="check"><input name="returnPallets" type="checkbox" /> Customer will return pallets (credit)</label>
    <label class="check"><input name="additionalPacking" type="checkbox" /> Additional packing</label>
  </fieldset>
  <fieldset>
    <legend>Delivery &amp; offloading</legend>
    <div class="grid2">
      <label>Distance to customer (km)<input name="deliveryDistanceKm" type="number" min="0" step="any" required placeholder="0 = collects" /></label>
      <label>Vehicle<select name="vehicle"></select></label>
    </div>
    <label class="check"><input name="otherProvince" type="checkbox" /> Delivery to another province</label>
    <div class="grid2">
      <label>Offloading<select name="offloading"></select></label>
      <label>Waiting time (hours)<input name="waitingHours" type="number" min="0" max="24" step="0.5" value="0" /></label>
    </div>
    <label class="check"><input name="difficultAccess" type="checkbox" /> Difficult site access</label>
  </fieldset>
  <fieldset>
    <legend>Installation</legend>
    <label class="check"><input name="includeLabour" type="checkbox" /> Include installation labour</label>
    <div class="grid2">
      <label>Slope<select name="slope"></select></label>
      <label>Ground preparation<select name="groundPrep"></select></label>
    </div>
  </fieldset>
  <fieldset>
    <legend>Customer &amp; discount</legend>
    <div class="grid2">
      <label>Customer type<select name="customerType"></select></label>
      <label data-negotiated hidden>Negotiated discount (%)<input name="negotiatedPercent" type="number" min="0" max="100" step="0.5" /></label>
    </div>
    <p class="muted small" style="margin:0">Discounts apply to materials only. Prices exclude VAT (added on the quote).</p>
  </fieldset>`;

const MATERIAL_HTML = `
  <div class="material">
    <div class="material-head">
      <strong data-title>Material 1</strong>
      <button type="button" data-remove>Remove</button>
    </div>
    <label>Brick, paver or product<select data-f="productKey"></select></label>
    <div class="muted small" data-info></div>
    <div class="grid2">
      <label>Colour<select data-f="colour"></select></label>
      <label>Finish<select data-f="finish"></select></label>
    </div>
    <label class="check"><input data-f="useCustomSize" type="checkbox" /> Use custom dimensions</label>
    <div class="grid3" data-custom-size hidden>
      <label>Length (mm)<input data-f="lengthMm" type="number" min="1" step="1" /></label>
      <label>Width (mm)<input data-f="widthMm" type="number" min="1" step="1" /></label>
      <label>Height (mm)<input data-f="heightMm" type="number" min="1" step="1" /></label>
    </div>
    <div class="grid2">
      <label>Quantity required<input data-f="quantity" type="number" min="0" step="any" required /></label>
      <label>Measured in<select data-f="quantityMode"></select></label>
    </div>
    <div class="grid2">
      <label>Wastage allowance<select data-f="wastagePreset"></select></label>
      <label data-custom-wastage hidden>Custom wastage (%)<input data-f="wastagePercent" type="number" min="0" max="30" step="0.5" /></label>
    </div>
  </div>`;

/**
 * Renders the job form into `root` (a <form> or any element).
 * @param {{options: object, currency: string, onChange?: () => void}} config
 */
export function createJobForm(root, { options, currency, onChange = () => {} }) {
  let opts = options;
  root.insertAdjacentHTML("beforeend", FORM_HTML);
  const q = (sel) => root.querySelector(sel);
  const field = (name) => root.querySelector(`[name="${name}"]`);
  const materialsBox = q("[data-materials]");
  const addButton = q("[data-add-material]");
  const R = (n) => money(n, currency);
  const f = (card, k) => card.querySelector(`[data-f="${k}"]`);
  const cards = () => [...materialsBox.children];
  const productOf = (card) => opts.products.find((p) => p.key === f(card, "productKey").value);
  const optionHtml = (list, label = (o) => o.name) =>
    list.map((o) => `<option value="${esc(o.key)}">${esc(label(o))}</option>`).join("");
  const unitWord = (p) => ({ brick: "bricks", block: "blocks", paver: "pavers", unit: "units", metre: "metres", "m²": "m²" })[p.unit] ?? p.unit;
  const sizeText = (s) => `${s.lengthMm} × ${s.widthMm} × ${s.heightMm} mm`;

  function fillShared() {
    const keep = Object.fromEntries(["vehicle", "offloading", "slope", "groundPrep", "customerType"].map((k) => [k, field(k).value]));
    field("vehicle").innerHTML = `<option value="auto">Choose by weight (cheapest)</option>` + optionHtml(opts.vehicles);
    field("offloading").innerHTML = optionHtml(opts.offloading);
    field("slope").innerHTML = optionHtml(opts.slope);
    field("groundPrep").innerHTML = optionHtml(opts.groundPrep);
    field("customerType").innerHTML = optionHtml(opts.discounts, (d) => (d.percent ? `${d.name} (${d.percent}%)` : d.name));
    for (const [k, v] of Object.entries(keep)) if (v && [...field(k).options].some((o) => o.value === v)) field(k).value = v;
  }

  function productOptions() {
    const groups = [...opts.categories.map((c) => [c.key, c.name])];
    const known = new Set(groups.map(([k]) => k));
    const leftovers = opts.products.filter((p) => !known.has(p.category));
    return groups
      .map(([cat, label]) => {
        const items = opts.products.filter((p) => p.category === cat);
        return items.length ? `<optgroup label="${esc(label)}">${optionHtml(items, (p) => `${p.name} – ${R(p.unitPrice)}/${p.unit}`)}</optgroup>` : "";
      })
      .join("") + (leftovers.length ? `<optgroup label="Other">${optionHtml(leftovers, (p) => `${p.name} – ${R(p.unitPrice)}/${p.unit}`)}</optgroup>` : "");
  }

  function fillMaterialOptions(card) {
    const keep = f(card, "productKey").value;
    f(card, "productKey").innerHTML = productOptions();
    if (keep && opts.products.some((p) => p.key === keep)) f(card, "productKey").value = keep;
    const preset = f(card, "wastagePreset").value;
    f(card, "wastagePreset").innerHTML =
      opts.wastageOptions.map((w) => `<option value="${w.percent}">${esc(w.name)} (${w.percent}%)</option>`).join("") +
      `<option value="custom">Custom wastage</option>`;
    f(card, "wastagePreset").value = preset && [...f(card, "wastagePreset").options].some((o) => o.value === preset) ? preset : "5";
    if (f(card, "wastagePreset").value === "") f(card, "wastagePreset").value = "custom";
  }

  function addMaterial() {
    const holder = document.createElement("div");
    holder.innerHTML = MATERIAL_HTML;
    const card = holder.firstElementChild;
    materialsBox.append(card);
    fillMaterialOptions(card);
    f(card, "productKey").addEventListener("change", () => updateProductFields(card, true));
    for (const k of ["useCustomSize", "wastagePreset"]) f(card, k).addEventListener("change", () => updateMaterialToggles(card));
    card.querySelector("[data-remove]").addEventListener("click", () => {
      card.remove();
      renumber();
      onChange();
    });
    updateProductFields(card, true);
    renumber();
    return card;
  }

  function renumber() {
    const list = cards();
    list.forEach((card, i) => {
      card.querySelector("[data-title]").textContent = `Material ${i + 1}`;
      card.querySelector("[data-remove]").hidden = list.length === 1;
    });
    addButton.disabled = list.length >= MAX_MATERIALS;
  }

  // Colour/finish, size and quantity choices depend on the product.
  function updateProductFields(card, reset) {
    const p = productOf(card);
    if (!p) return;
    const choose = (select, choices, builtIn, table) => {
      if (choices) {
        select.disabled = false;
        select.innerHTML = optionHtml(
          choices.map((k) => table.find((x) => x.key === k)).filter(Boolean),
          (x) => (x.surcharge ? `${x.name} (+${R(x.surcharge)}/${p.unit})` : x.name),
        );
      } else {
        select.disabled = true;
        select.innerHTML = `<option value="">${esc(builtIn ? `${builtIn} (included)` : "n/a")}</option>`;
      }
    };
    const colour = f(card, "colour");
    const finish = f(card, "finish");
    const prevColour = colour.value;
    const prevFinish = finish.value;
    choose(colour, p.colourOptions, p.colour, opts.colours);
    choose(finish, p.finishOptions, p.finish, opts.finishes);
    if (!reset) {
      if ([...colour.options].some((o) => o.value === prevColour)) colour.value = prevColour;
      if ([...finish.options].some((o) => o.value === prevFinish)) finish.value = prevFinish;
    }

    const modes = [];
    if (p.unit === "m²") modes.push(["units", "Square metres (m²)"]);
    else {
      modes.push(["units", `Number of ${unitWord(p)}`]);
      if (p.supportsArea) modes.push(["area", "Area to cover (m²)"]);
    }
    const mode = f(card, "quantityMode");
    const prevMode = mode.value;
    mode.innerHTML = modes.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    if (modes.some(([v]) => v === prevMode)) mode.value = prevMode;

    const info = [];
    if (p.size) info.push(`Size ${sizeText(p.size)}${p.sizeVerified ? "" : " (typical, confirm)"}`);
    if (p.coveragePerM2) info.push(`${p.coveragePerM2}/m² (catalogue rate)`);
    else if (p.supportsArea && p.unit !== "m²") info.push("coverage estimated from size");
    info.push(`${p.unitsPerPallet} ${p.unit === "m²" ? "m²" : unitWord(p)} per pallet`);
    if (p.deliveryRequirement && p.deliveryRequirement !== "none") info.push(`needs ${p.deliveryRequirement} offloading`);
    card.querySelector("[data-info]").textContent = info.join(" · ");
    if (reset && p.size) {
      f(card, "lengthMm").value = p.size.lengthMm;
      f(card, "widthMm").value = p.size.widthMm;
      f(card, "heightMm").value = p.size.heightMm;
    }
    if (reset && p.defaultWastagePercent !== null && p.defaultWastagePercent !== undefined) {
      const preset = opts.wastageOptions.find((w) => w.percent === p.defaultWastagePercent);
      f(card, "wastagePreset").value = preset ? String(preset.percent) : "custom";
      f(card, "wastagePercent").value = p.defaultWastagePercent;
    }
    updateMaterialToggles(card);
  }

  function updateMaterialToggles(card) {
    card.querySelector("[data-custom-size]").hidden = !f(card, "useCustomSize").checked;
    card.querySelector("[data-custom-wastage]").hidden = f(card, "wastagePreset").value !== "custom";
  }

  function updateToggles() {
    q("[data-negotiated]").hidden = field("customerType").value !== "negotiated";
    const labour = field("includeLabour").checked;
    field("slope").disabled = field("groundPrep").disabled = !labour;
    const km = field("deliveryDistanceKm");
    const collect = Number(km.value) === 0 && km.value !== "";
    field("vehicle").disabled = field("offloading").disabled = field("waitingHours").disabled = collect;
  }

  function writeMaterial(card, m) {
    if (![...f(card, "productKey").options].some((o) => o.value === m.productKey)) {
      // A product no longer on sale: keep it selectable so the job still reads correctly.
      f(card, "productKey").insertAdjacentHTML("beforeend", `<option value="${esc(m.productKey)}">${esc(m.productKey)} (not on the price list)</option>`);
    }
    f(card, "productKey").value = m.productKey;
    updateProductFields(card, false);
    for (const k of MATERIAL_FIELDS) {
      const input = f(card, k);
      if (!input || k === "productKey") continue;
      if (input.type === "checkbox") input.checked = !!m[k];
      else if (!(k.endsWith("Mm") && !m.useCustomSize)) input.value = m[k] ?? "";
    }
    const preset = opts.wastageOptions.find((w) => w.percent === m.wastagePercent);
    f(card, "wastagePreset").value = preset ? String(preset.percent) : "custom";
    updateMaterialToggles(card);
  }

  const numberOf = (input, fallback = NaN) => (input.value === "" ? fallback : Number(input.value));

  function readMaterial(card) {
    const custom = f(card, "useCustomSize").checked;
    const preset = f(card, "wastagePreset").value;
    return {
      productKey: f(card, "productKey").value,
      colour: f(card, "colour").value,
      finish: f(card, "finish").value,
      useCustomSize: custom,
      lengthMm: custom ? numberOf(f(card, "lengthMm")) : 0,
      widthMm: custom ? numberOf(f(card, "widthMm")) : 0,
      heightMm: custom ? numberOf(f(card, "heightMm")) : 0,
      quantityMode: f(card, "quantityMode").value,
      quantity: numberOf(f(card, "quantity")),
      wastagePercent: preset === "custom" ? numberOf(f(card, "wastagePercent")) : Number(preset),
    };
  }

  const api = {
    read() {
      const num = (k, fallback) => numberOf(field(k), fallback);
      return {
        materials: cards().map(readMaterial),
        deliveryDistanceKm: num("deliveryDistanceKm"),
        otherProvince: field("otherProvince").checked,
        vehicle: field("vehicle").value,
        offloading: field("offloading").value,
        difficultAccess: field("difficultAccess").checked,
        waitingHours: num("waitingHours", 0),
        returnPallets: field("returnPallets").checked,
        additionalPacking: field("additionalPacking").checked,
        includeLabour: field("includeLabour").checked,
        slope: field("slope").value,
        groundPrep: field("groundPrep").value,
        customerType: field("customerType").value,
        negotiatedPercent: field("customerType").value === "negotiated" ? num("negotiatedPercent") : 0,
      };
    },

    write(job) {
      // Jobs saved before a job could hold several materials have one product at the top level.
      const materials = job.materials ?? [job];
      materialsBox.innerHTML = "";
      for (const m of materials) writeMaterial(addMaterial(), m);
      for (const [k, v] of Object.entries(job)) {
        const input = field(k);
        if (!input || k === "materials" || MATERIAL_FIELDS.includes(k)) continue;
        if (input.type === "checkbox") input.checked = !!v;
        else input.value = v ?? "";
      }
      updateToggles();
    },

    /** Labels of required fields that are empty. */
    missing() {
      const job = api.read();
      const label = (input) => input.closest("label").firstChild.textContent.trim();
      return job.materials.flatMap((m, i) =>
        ["lengthMm", "widthMm", "heightMm", "quantity", "wastagePercent"]
          .filter((k) => !Number.isFinite(m[k]))
          .map((k) => `${label(f(cards()[i], k))}${job.materials.length > 1 ? ` (material ${i + 1})` : ""}`),
      ).concat(["deliveryDistanceKm", "negotiatedPercent"].filter((k) => !Number.isFinite(job[k])).map((k) => label(field(k))));
    },

    /** New choices from the price list, keeping what's been entered. */
    setOptions(next) {
      const job = api.read();
      opts = next;
      fillShared();
      for (const card of cards()) fillMaterialOptions(card);
      api.write(job);
    },

    focusNewMaterial() {
      f(addMaterial(), "productKey").focus();
    },
  };

  fillShared();
  addMaterial();
  updateToggles();
  addButton.addEventListener("click", () => {
    api.focusNewMaterial();
    onChange();
  });
  for (const name of ["includeLabour", "customerType", "deliveryDistanceKm"]) {
    field(name).addEventListener("input", updateToggles);
    field(name).addEventListener("change", updateToggles);
  }
  root.addEventListener("change", () => onChange());
  return api;
}
