// The printable quotation document shown under a quote in the chat, and its PDF download.
import { esc } from "/common.js";

export const DOC_WIDTH = 794; // A4 width in CSS pixels

// "R 28 500.00", as on printed South African quotes.
export function docMoney(n, currency = "ZAR") {
  const abs = Math.abs(n ?? 0)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${n < 0 ? "-" : ""}${currency === "ZAR" ? "R" : currency} ${abs}`;
}

const longDate = (d) =>
  new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
// "5 250 pavers", "2 trips", "100 m²".
const qty = (n, unit) => {
  const num = Number.isInteger(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") : String(n);
  if (!unit) return num;
  return `${num} ${n !== 1 && /^[a-z]+$/.test(unit) ? `${unit}s` : unit}`;
};
const lines = (text) => esc(text ?? "").replace(/\n/g, "<br>");

const icon = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-2.9a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h2.9c.3 1.3.8 2.5 1.4 3.6A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-3.6C8.8 5.5 8.3 6.7 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h2.9a8 8 0 0 1-4.3 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="m7 12.5 3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="3.2"/><circle cx="5" cy="9" r="2.4"/><circle cx="19" cy="9" r="2.4"/><path d="M6 20c0-3.9 2.7-7 6-7s6 3.1 6 7zM0 19c0-2.8 1.8-5 4.2-5 .6 0 1.2.1 1.7.4A9 9 0 0 0 4.4 19zm24 0h-4.4a9 9 0 0 0-1.5-4.6c.5-.3 1.1-.4 1.7-.4 2.4 0 4.2 2.2 4.2 5z"/></svg>',
  truck: '<svg viewBox="0 0 24 24"><path d="M1 5h13v10H1zm14 3h4l3 4v3h-7z"/><circle cx="5.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>',
};

// Classical columns, as in the logo.
const columnsSvg = `<svg class="qd-columns" viewBox="0 0 64 48">
  <path d="M2 14 32 2l30 12z" fill="#fff"/><rect x="4" y="15" width="56" height="3" fill="#fff"/>
  ${[8, 18, 28, 38, 48].map((x) => `<rect x="${x}" y="20" width="6" height="22" fill="#fff"/>`).join("")}
  <rect x="3" y="43" width="58" height="4" fill="#fff"/></svg>`;

// Grey pavers, clipped to the header's slanted corner. Drawn as an image because
// the PDF renderer can't paint SVG patterns or clip paths inline.
const pavingSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 270" preserveAspectRatio="none">
  <defs>
    <pattern id="qdPave" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
      <rect width="44" height="44" fill="#6f7378"/>
      <rect x="1.5" y="1.5" width="41" height="19" rx="2" fill="#b4b8bd"/>
      <rect x="1.5" y="23.5" width="19" height="19" rx="2" fill="#a3a7ac"/>
      <rect x="23.5" y="23.5" width="19" height="19" rx="2" fill="#c3c6ca"/>
    </pattern>
    <clipPath id="qdClip"><polygon points="95,0 250,0 250,270 0,270"/></clipPath>
  </defs>
  <g clip-path="url(#qdClip)"><rect width="250" height="270" fill="url(#qdPave)"/></g>
  <polygon points="82,0 98,0 6,270 -10,270" fill="#e1251b"/>
  <polygon points="40,270 120,140 120,270" fill="#13306b"/>
</svg>`;

const bricksSvg = `<svg class="qd-bricks" viewBox="0 0 64 48" fill="#13306b">
  <path d="M6 20 26 12l18 7-20 8z"/><path d="M6 20v8l18 7v-8z" opacity=".75"/><path d="M24 27v8l20-8v-8z" opacity=".55"/>
  <path d="M22 32 42 24l18 7-20 8z"/><path d="M22 32v8l18 7v-8z" opacity=".75"/><path d="M40 39v8l20-8v-8z" opacity=".55"/>
  <path d="M28 10 46 3l14 6-18 7z"/><path d="M28 10v6l14 6v-6z" opacity=".75"/><path d="M42 16v6l18-7V9z" opacity=".55"/>
</svg>`;

/**
 * @param {object} d
 *   number, issued, expires, validDays, currency, customer, project {name, site, description},
 *   pricing {lines, subtotal, taxRatePercent, tax, total}, notes, company (quoteDocument settings)
 */
export function quoteDocHtml(d) {
  const c = d.company ?? {};
  const cur = d.currency;
  const [brandTop, ...brandRest] = String(c.companyName ?? "").split(" ");
  const tagline = String(c.tagline ?? "")
    .split("|")
    .map((t) => `<span>${esc(t.trim())}</span>`)
    .join('<i class="qd-sep">|</i>');
  const terms = String(c.terms ?? "")
    .replaceAll("{days}", c.validDays)
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  if (d.notes) terms.push(d.notes);
  const cust = d.customer ?? {};
  const rows = d.pricing.lines
    .map(
      (l, i) => `<tr>
        <td class="qd-n">${i + 1}</td>
        <td><b>${esc(l.name)}</b>${l.detail ? `<div class="qd-detail">${esc(l.detail)}</div>` : ""}</td>
        <td class="qd-c">${esc(qty(l.quantity, l.unit))}</td>
        <td class="qd-r">${docMoney(l.unitPrice, cur)}</td>
        <td class="qd-r">${docMoney(l.lineTotal, cur)}</td>
      </tr>`,
    )
    .join("");
  const field = (label, value) =>
    `<div class="qd-field"><span>${label}</span><div>${value || "—"}</div></div>`;

  return `<div class="qdoc">
    <header class="qd-head">
      <div class="qd-brand">
        <div class="qd-logo">
          <div class="qd-logo-main">${columnsSvg}<div><div class="qd-logo-top">${esc(brandTop)}</div><div class="qd-logo-sub">${esc(brandRest.join(" "))}</div></div></div>
          <div class="qd-logo-red"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M0 0 H70 C70 55 45 88 0 100 Z" fill="#e1251b"/><path d="M76 0 C76 58 50 93 0 106" fill="none" stroke="#fff" stroke-width="4"/></svg></div>
        </div>
        <div class="qd-tagline">${tagline}</div>
      </div>
      <ul class="qd-contact">
        ${c.address ? `<li>${icon.pin}<span>${lines(c.address)}</span></li>` : ""}
        ${c.phone ? `<li>${icon.phone}<span>${esc(c.phone)}</span></li>` : ""}
        ${c.email ? `<li>${icon.mail}<span>${esc(c.email)}</span></li>` : ""}
        ${c.website ? `<li>${icon.globe}<span>${esc(c.website)}</span></li>` : ""}
      </ul>
      <img class="qd-corner" alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(pavingSvg)}" />
    </header>

    <div class="qd-banner">
      <svg class="qd-banner-bg" viewBox="0 0 760 74" preserveAspectRatio="none"><polygon points="0,0 700,0 760,74 0,74" fill="#13306b"/></svg>
      <h1>QUOTATION</h1><span class="qd-bar"></span><p>${esc(c.subtitle ?? "")}</p>
    </div>

    <div class="qd-meta">
      <dl>
        <dt>Quote No:</dt><dd><b>${esc(d.number)}</b></dd>
        <dt>Issue Date:</dt><dd>${longDate(d.issued)}</dd>
        <dt>Expiry Date:</dt><dd>${longDate(d.expires)} <em>(Valid for ${esc(String(c.validDays))} days)</em></dd>
      </dl>
      <div class="qd-badge">${bricksSvg}<div><strong>Quality paving<br>products &amp; installation</strong>
        <small>Durable <i>|</i> Stylish <i>|</i> Built to last</small></div></div>
    </div>

    <div class="qd-panels">
      <section><h2>Customer details</h2>
        ${field("Name:", esc(cust.company || cust.name))}
        ${cust.company && cust.name ? field("Contact Person:", esc(cust.name)) : ""}
        ${field("Address:", lines(cust.address))}
        ${field("Phone:", esc(cust.phone))}
        ${field("Email:", esc(cust.email))}
      </section>
      <section><h2>Project details</h2>
        ${field("Project Name:", esc(d.project?.name))}
        ${field("Site Address:", lines(d.project?.site))}
        ${field("Project Description:", esc(d.project?.description))}
      </section>
    </div>

    <table class="qd-items">
      <thead><tr><th>#</th><th>Description</th><th>Quantity</th><th>Unit price<br>(excl. VAT)</th><th>Amount<br>(excl. VAT)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="qd-bottom">
      <div class="qd-terms"><h3><span class="qd-i">i</span>Terms &amp; notes</h3>
        <ol>${terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
      </div>
      <table class="qd-totals">
        <tr><td>Subtotal (Excl. VAT)</td><td>${docMoney(d.pricing.subtotal, cur)}</td></tr>
        <tr><td>VAT (${esc(String(d.pricing.taxRatePercent))}%)</td><td>${docMoney(d.pricing.tax, cur)}</td></tr>
        <tr class="qd-grand"><td>TOTAL <small>(Incl. VAT)</small></td><td>${docMoney(d.pricing.total, cur)}</td></tr>
      </table>
    </div>

    <div class="qd-sign">
      <div><h4>For ${esc(c.companyName)}</h4>
        <div class="qd-sig-row"><div class="qd-line"><div class="qd-sig-name">${esc(c.signatory)}</div></div><div class="qd-line qd-date">${longDate(d.issued)}</div></div>
        <div class="qd-sig-row qd-labels"><span>${c.signatory ? `<b>${esc(c.signatory)}</b><br>` : ""}${esc(c.signatoryTitle ?? "")}</span><span>Date</span></div>
      </div>
      <div><h4>Customer Approval</h4>
        <div class="qd-sig-row"><div class="qd-line"></div><div class="qd-line qd-date"></div></div>
        <div class="qd-sig-row qd-labels"><span>Name &amp; Signature</span><span>Date</span></div>
      </div>
    </div>

    <footer class="qd-foot">
      <div>${icon.check}<span>Trusted brands<br><small>for generations</small></span></div>
      <div>${icon.people}<span>Expert support<br><small>from start to finish</small></span></div>
      <div>${icon.truck}<span>Building stronger<br><small>communities together</small></span></div>
      <div class="qd-slogan"><svg viewBox="0 0 200 64" preserveAspectRatio="none"><polygon points="24,0 200,0 200,64 0,64" fill="#e1251b"/></svg><span>More than just bricks.</span></div>
    </footer>
  </div>`;
}

let libLoading = null;
const loadLib = () =>
  (libLoading ??= new Promise((resolve, reject) => {
    if (window.html2pdf) return resolve(window.html2pdf);
    const s = Object.assign(document.createElement("script"), { src: "/vendor/html2pdf.bundle.min.js" });
    s.onload = () => resolve(window.html2pdf);
    s.onerror = () => {
      libLoading = null;
      reject(new Error("Couldn't load the PDF generator"));
    };
    document.head.append(s);
  }));

function rasterize(src, width, height, scale = 3) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = Object.assign(document.createElement("canvas"), { width: width * scale, height: height * scale });
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

/** Renders the document at full A4 width and saves it as a PDF. */
export async function downloadQuotePdf(d) {
  const html2pdf = await loadLib();
  const holder = document.createElement("div");
  holder.innerHTML = quoteDocHtml(d);
  const el = holder.firstElementChild;
  // The PDF renderer can't paint the SVG corner image, so hand it a bitmap.
  const corner = el.querySelector(".qd-corner");
  if (corner) corner.src = await rasterize(corner.src, 150, 270);
  const file = `Quotation ${d.number}${d.customer?.company || d.customer?.name ? ` - ${d.customer.company || d.customer.name}` : ""}.pdf`;
  const options = (pagebreak) => ({
    margin: 0,
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: DOC_WIDTH },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak,
  });
  const name = file.replace(/[\\/:*?"<>|]/g, "-");
  const worker = html2pdf().set(options({ mode: [] })).from(el);
  const canvas = await worker.toCanvas().get("canvas");
  // Quotes up to ~35% longer than a page are shrunk onto one page; longer ones span pages.
  const [pageW, pageH] = [210, 297];
  const fullH = (pageW * canvas.height) / canvas.width;
  if (fullH / pageH > 1.35) {
    const breaks = { mode: ["css"], avoid: ["tr", ".qd-bottom", ".qd-sign", ".qd-foot", ".qd-panels"] };
    return html2pdf().set({ ...options(breaks), filename: name }).from(el).save();
  }
  // Reuse the generated PDF: replace its pages with a single scaled page.
  const pdf = await worker.toPdf().get("pdf");
  const pages = pdf.internal.getNumberOfPages();
  pdf.addPage("a4", "portrait");
  for (let i = pages; i >= 1; i--) pdf.deletePage(i);
  const h = Math.min(fullH, pageH);
  const w = (h * canvas.width) / canvas.height;
  pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", (pageW - w) / 2, 0, w, h);
  pdf.save(name);
}
