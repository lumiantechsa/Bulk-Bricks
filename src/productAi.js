// AI-assisted product entry: turns a description such as "a charcoal paving
// brick, 200 by 100 by 50 mm, R7.50 each, 500 per pallet" into a draft product
// for staff to check and complete. The model only reads; it can't save. Every
// number it returns must appear in the description, otherwise it is dropped
// and staff are asked for it, so prices and sizes are never invented.
import { checkProduct, MATERIAL_UNITS } from "./catalog.js";
import { modelFor } from "./agent.js";

const MAX_TEXT = 2000;
const NUMERIC_FIELDS = [
  "unitPrice", "lengthMm", "widthMm", "heightMm", "unitsPerPallet", "weightKg", "coveragePerM2", "labourRate",
  "defaultWastagePercent", "minQuantity",
];
const nullable = (type, description) => ({ type: [type, "null"], description });

function toolSchema(categories) {
  const properties = {
    name: nullable("string", "Product name as staff would see it in the price list."),
    category: { type: ["string", "null"], enum: [...categories.map((c) => c.key), null], description: "Best matching existing category key." },
    description: nullable("string", "Short description, only from what was said."),
    sku: nullable("string", "Product code, only if one was given."),
    unit: nullable("string", `Unit of sale. For bricks, blocks, pavers and other materials use one of: ${MATERIAL_UNITS.join(", ")}. For accessories and services use the unit stated (bag, m³, hour, trip, job...).`),
    unitPrice: nullable("number", "Selling price per unit in rand, excluding VAT, only if stated."),
    lengthMm: nullable("number", "Length in mm, only if stated in mm."),
    widthMm: nullable("number", "Width in mm, only if stated in mm."),
    heightMm: nullable("number", "Height or thickness in mm, only if stated in mm."),
    unitsPerPallet: nullable("number", "Units per pallet, only if stated."),
    weightKg: nullable("number", "Weight of one unit in kg, only if stated."),
    coveragePerM2: nullable("number", "Units per m², only if stated."),
    colour: nullable("string", "Colour, if part of the product."),
    finish: nullable("string", "Finish, if part of the product."),
    labourRate: nullable("number", "Installation labour rate in rand, only if stated."),
    defaultWastagePercent: nullable("number", "Wastage allowance %, only if stated."),
    minQuantity: nullable("number", "Minimum order quantity (accessories/services), only if stated."),
    deliveryRequirement: { type: ["string", "null"], enum: ["none", "forklift", "crane", null], description: "Only if the description says offloading needs a forklift or crane." },
    vatTreatment: { type: ["string", "null"], enum: ["standard", "zero_rated", "exempt", null], description: "Only if the description says so." },
    questions: { type: "array", items: { type: "string" }, description: "Anything ambiguous you want staff to confirm." },
  };
  return {
    name: "record_product",
    description: "Record the product details found in the description. Use null for anything not stated.",
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
}

const SYSTEM = `You help staff of a brick, paving and tile supplier add products to their price list. Read the \
description and call record_product with the details it states. Rules:
- Never estimate, assume or look up a price, size, weight, pallet quantity, coverage or labour rate. If the \
description doesn't state it, use null. Staff will be asked for it.
- Copy numbers exactly as stated; don't convert units (if a size is given in cm, leave it null and add a question).
- Choose the closest existing category; if none fits, use "other" and add a question.
- Write the product name in title case, e.g. "Charcoal Paving Brick".`;

/** Numbers written in the text, e.g. "R7.50", "7,50", "1 000", "1,000", "200x100x50". */
export function numbersIn(text) {
  const t = String(text)
    .replace(/(\d)[  ](?=\d{3}\b)/g, "$1")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  return new Set((t.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(",", "."))));
}

async function callModel({ client, provider, text, tool }) {
  const model = modelFor(provider);
  if (provider === "openai") {
    const res = await client.chat.completions.create({
      model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text }],
      tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema, strict: true } }],
      tool_choice: { type: "function", function: { name: tool.name } },
    });
    const call = res.choices[0].message.tool_calls?.[0];
    if (!call) throw new Error("The assistant didn't return product details");
    return JSON.parse(call.function.arguments);
  }
  const res = await client.beta.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [{ ...tool, strict: true }],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block) throw new Error("The assistant didn't return product details");
  return block.input;
}

/**
 * @returns {{draft: object, missing: Array<{key, label}>, unconfirmed: string[], questions: string[]}}
 */
export async function extractProduct({ client, provider, text, categories }) {
  const description = String(text ?? "").trim().slice(0, MAX_TEXT);
  if (!description) throw Object.assign(new Error("Describe the product first."), { status: 400 });
  const raw = await callModel({ client, provider, text: description, tool: toolSchema(categories) });

  const stated = numbersIn(description);
  const draft = {};
  const unconfirmed = [];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === "questions" || v === null || v === undefined || v === "") continue;
    if (NUMERIC_FIELDS.includes(k)) {
      // Deterministic guard against invented figures.
      if (typeof v !== "number" || !stated.has(v)) {
        unconfirmed.push(k);
        continue;
      }
    }
    draft[k] = v;
  }
  if (draft.category && !categories.some((c) => c.key === draft.category)) delete draft.category;
  const category = categories.find((c) => c.key === draft.category);
  if (category?.kind === "material") {
    if (draft.unit && !MATERIAL_UNITS.includes(draft.unit)) delete draft.unit;
    draft.layout ??= { brick: "wall", block: "wall", paver: "paving" }[category.key] ?? null;
    draft.labourBasis ??= "area";
    if (draft.lengthMm && draft.widthMm && draft.heightMm) draft.sizeVerified = true;
  }
  draft.vatTreatment ??= "standard";
  draft.deliveryRequirement ??= "none";
  const { missing } = checkProduct(draft, categories, { partial: true });
  return { draft, missing, unconfirmed, questions: Array.isArray(raw?.questions) ? raw.questions.slice(0, 10) : [] };
}
