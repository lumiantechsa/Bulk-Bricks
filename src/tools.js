// Tools the quoting agent can call. Each handler returns a JSON-serialisable
// result or throws; throws become is_error tool results the model can recover from.
import { calculateJobQuote, MAX_MATERIALS, needsApproval, normalizeJob, PricingError } from "./pricing.js";

const extrasSchema = {
  type: "array",
  description: "Accessories (sand, cement, kerbs, sealer) and services from list_catalog, by SKU. Can be empty.",
  items: {
    type: "object",
    properties: {
      sku: { type: "string" },
      quantity: { type: "number", description: "Quantity in the product's unit" },
    },
    required: ["sku", "quantity"],
    additionalProperties: false,
  },
};

// One material of a job: a product with its own colour, finish, size, quantity and wastage.
const materialProperties = {
  productKey: { type: "string", description: "Product key from list_catalog (bricks, blocks, pavers or other products)." },
  colour: { type: "string", description: 'Colour key, only for products with colourOptions; otherwise "".' },
  finish: { type: "string", description: 'Finish key, only for products with finishOptions; otherwise "".' },
  useCustomSize: { type: "boolean", description: "True to override the product size with the dimensions below." },
  lengthMm: { type: "number", description: "Custom length in mm (0 if not used)." },
  widthMm: { type: "number", description: "Custom width in mm (0 if not used)." },
  heightMm: { type: "number", description: "Custom height/thickness in mm (0 if not used)." },
  quantityMode: {
    type: "string",
    enum: ["units", "area"],
    description: "units = quantity in the product's unit of sale; area = m² to cover (uses the coverage rate).",
  },
  quantity: { type: "number" },
  wastagePercent: { type: "number", description: "0, 3, 5 or 10 (or a custom %, max 30). 5 if unknown." },
};

// The same fields as the job form in the chat: a list of materials plus the
// delivery, pallet, labour and customer details they share.
const jobProperties = {
  materials: {
    type: "array",
    description:
      `The materials in this job, one entry per product (e.g. face bricks for the walls and pavers for the ` +
      `driveway), each with its own parameters. 1 to ${MAX_MATERIALS} entries.`,
    items: {
      type: "object",
      properties: materialProperties,
      required: Object.keys(materialProperties),
      additionalProperties: false,
    },
  },
  deliveryDistanceKm: { type: "number", description: "One-way km to site. 0 if the customer collects." },
  otherProvince: { type: "boolean", description: "Delivery to another province (custom quote)." },
  vehicle: { type: "string", description: 'Vehicle key from list_catalog, or "auto" to choose by weight and price.' },
  offloading: { type: "string", description: "Offloading key from list_catalog (standard, crane, forklift, manual)." },
  difficultAccess: { type: "boolean" },
  waitingHours: { type: "number", description: "Expected extra waiting time on site, in hours (usually 0)." },
  returnPallets: { type: "boolean", description: "Customer will return the pallets for a credit." },
  additionalPacking: { type: "boolean" },
  includeLabour: { type: "boolean" },
  slope: { type: "string", description: "Slope key from list_catalog." },
  groundPrep: { type: "string", description: "Ground preparation key from list_catalog." },
  customerType: { type: "string", description: "standard, contractor, bulk or negotiated." },
  negotiatedPercent: { type: "number", description: "Discount % when customerType is negotiated, else 0." },
};

/**
 * Saves the chat's job as its draft quotation, so every quotation the
 * assistant prices shows up under Quotations straight away. The draft follows
 * the current prices until it's issued; manual edits made to it in the
 * Quotations editor (extras, manual lines, price changes) are kept.
 */
async function saveDraft({ store, conv, user }, action) {
  const input = { job: conv.job, customer: conv.customer };
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = conv.draftQuotationId ? await store.quotations.get(conv.draftQuotationId) : null;
    if (!draft || draft.status !== "draft") {
      const created = await store.quotations.create({ input, status: "draft", conversationId: conv.id, user, action: "created", summary: "Created by the quoting assistant" });
      conv.draftQuotationId = created.id;
      return created;
    }
    try {
      return await store.quotations.update(draft.id, { input, version: draft.version, user, action, refresh: true, summary: "Updated from the quoting assistant" });
    } catch (err) {
      if (err.status !== 409 || attempt) throw err;
    }
  }
}

/** Validates and prices a job, stores it on the conversation and shows the estimate in the chat. */
export async function applyJob(job, ctx, source) {
  const { store, conv } = ctx;
  const clean = normalizeJob(job);
  const estimate = calculateJobQuote(clean, [], await store.getPricingContext());
  conv.job = clean;
  const draft = await saveDraft(ctx, "estimate");
  conv.transcript.push({
    role: "event", type: "estimate", source, estimate, quotationId: draft.id, number: draft.number, at: new Date().toISOString(),
  });
  await store.touch(conv);
  return estimate;
}

async function priceCurrentJob({ store, conv }, extras) {
  if (!conv.job) {
    throw new PricingError("No job details yet. Ask the employee to fill in the job form, or call set_job_details.");
  }
  return calculateJobQuote(conv.job, extras, await store.getPricingContext());
}

export const toolDefinitions = [
  {
    name: "list_catalog",
    description:
      "List the rate card (products with unit price, size, coverage per m², units per pallet and colour/finish " +
      "options; colour and finish surcharges; wastage options; pallet fees; delivery brackets and vehicles; " +
      "offloading; slope and ground preparation; customer discounts; pricing adjustments) and the accessories and services. " +
      "Everything comes from the live price list, so call this " +
      "before quoting; never guess prices or keys.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "set_job_details",
    description:
      "Set or update the job details (the same fields as the job form). A job can have several materials, " +
      "each with its own product, colour, finish, size, quantity and wastage; always pass the full list. Prices the job and shows the " +
      "estimate to the employee. Only call it when the employee gave the details in chat; form submissions are already saved.",
    strict: true,
    input_schema: {
      type: "object",
      properties: jobProperties,
      required: Object.keys(jobProperties),
      additionalProperties: false,
    },
  },
  {
    name: "calculate_quote",
    description:
      "Price the current job plus any accessories, with the job's discount and tax. Read-only: use it to give " +
      "the employee an estimate before they confirm.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        extras: extrasSchema,
      },
      required: ["extras"],
      additionalProperties: false,
    },
  },
  {
    name: "save_customer_details",
    description:
      "Record the contact details of the CUSTOMER the quote is for (not the employee you are talking to). Pass empty strings for unknown fields.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        company: { type: "string" },
        phone: { type: "string" },
        address: { type: "string", description: "Customer's postal or business address." },
      },
      required: ["name", "email", "company", "phone", "address"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_quote",
    description:
      "Create a formal quote for the current job (plus extras) once the employee has confirmed it and you have the " +
      "customer's name and email. " +
      "Large or discounted quotes go to a manager for approval; tell the employee if so.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        extras: extrasSchema,
        project_name: { type: "string", description: 'Short name for the job, e.g. "Driveway paving". Can be "".' },
        site_address: { type: "string", description: "Where the work or delivery is. Can be \"\" if unknown." },
        project_summary: {
          type: "string",
          description: "One or two sentences describing the job, for the quote header.",
        },
        notes: {
          type: "string",
          description: "Customer-visible notes: deadlines, assumptions, what's excluded.",
        },
      },
      required: ["extras", "project_name", "site_address", "project_summary", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Flag this conversation for a staff member: products or sizes not on the rate card, long-distance " +
      "delivery, discounts above the limit, or anything you are unsure about. The employee stays in the chat.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What staff need to know to pick this up." },
        urgency: { type: "string", enum: ["low", "normal", "high"] },
      },
      required: ["reason", "urgency"],
      additionalProperties: false,
    },
  },
];

const handlers = {
  async list_catalog(_input, { store, conv }) {
    const { rates, catalog, settings, categories } = await store.getPricingContext();
    return {
      rate_card: { currency: settings.currency, ...rates },
      product_categories: categories,
      accessories_and_services: catalog
        .filter((p) => p.active !== false)
        .map(({ sku, name, description, unit, unitPrice, minQuantity, volumeTiers, kind }) => ({
          sku,
          name,
          description,
          kind,
          unit,
          unitPrice,
          minQuantity: minQuantity ?? 1,
          volumeTiers: volumeTiers ?? [],
        })),
      current_job: conv.job,
    };
  },

  async set_job_details(input, ctx) {
    return { saved: true, estimate: await applyJob(input, ctx, "agent") };
  },

  calculate_quote({ extras }, ctx) {
    return priceCurrentJob(ctx, extras);
  },

  async save_customer_details(input, ctx) {
    const { store, conv } = ctx;
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && v.trim()) conv.customer[k] = v.trim();
    }
    if (conv.draftQuotationId && conv.job) await saveDraft(ctx, "customer");
    await store.touch(conv);
    return { saved: conv.customer };
  },

  async submit_quote({ extras, project_name, site_address, project_summary, notes }, ctx) {
    const { store, conv, user } = ctx;
    if (!conv.customer.name || !conv.customer.email) {
      throw new PricingError("Ask the employee for the customer's name and email (save_customer_details) first.");
    }
    if (!conv.job) {
      throw new PricingError("No job details yet. Ask the employee to fill in the job form, or call set_job_details.");
    }
    const settings = await store.getSettings();
    const draft = conv.draftQuotationId ? await store.quotations.get(conv.draftQuotationId) : null;
    const usable = draft?.status === "draft" ? draft : null;
    const input = {
      job: conv.job,
      extras,
      customer: conv.customer,
      projectName: project_name ?? "",
      siteAddress: site_address ?? "",
      projectSummary: project_summary,
      notes,
      customLines: usable?.customLines ?? [],
      overrides: usable?.overrides ?? {},
    };
    const { pricing } = await store.quotations.price(input);
    const status = needsApproval(pricing, settings) ? "pending_review" : "sent";
    const quote = usable
      ? await store.quotations.update(usable.id, { input, version: usable.version, user, status, action: "issued", refresh: true, summary: "Issued by the quoting assistant" })
      : await store.quotations.create({ input, status, conversationId: conv.id, user, action: "issued", summary: "Issued by the quoting assistant" });
    conv.draftQuotationId = null;
    conv.transcript.push({ role: "event", type: "quote", quoteId: quote.id, at: new Date().toISOString() });
    await store.touch(conv);
    return {
      quote_id: quote.id,
      quote_number: quote.number,
      status: quote.status,
      total: quote.total,
      currency: quote.currency,
      valid_until: quote.validUntil,
      message: status === "pending_review"
        ? "Quote saved and sent to a manager for approval. The employee will see it update in this chat once approved."
        : "Quote issued and ready to send to the customer. The employee can see it in this chat and under Quotations.",
    };
  },

  async escalate_to_human({ reason, urgency }, { store, conv }) {
    conv.status = "needs_human";
    conv.escalation = { reason, urgency, at: new Date().toISOString() };
    conv.transcript.push({ role: "event", type: "escalation", text: reason, at: conv.escalation.at });
    await store.touch(conv);
    return { escalated: true, note: "A staff member has been notified and can reply in this chat." };
  },
};

export async function runTool(name, input, ctx) {
  const handler = handlers[name];
  if (!handler) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    return { content: JSON.stringify(await handler(input ?? {}, ctx)), isError: false };
  } catch (err) {
    if (err instanceof PricingError) return { content: err.message, isError: true };
    console.error(`Tool ${name} failed`, err);
    return { content: `Internal error while running ${name}.`, isError: true };
  }
}
