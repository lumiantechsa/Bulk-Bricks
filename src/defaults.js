// Seed data, used once to fill an empty database (and by the pricing tests).
// After that the database is the source of truth: prices, products and
// pricing variables are managed under Pricing Management, never here.
// All prices are made-up example figures in South African rand (ZAR), excl. VAT.

export const defaultSettings = {
  companyName: "Bulkbrick Supplies",
  currency: "ZAR",
  taxRatePercent: 15,
  // The agent may apply up to this discount on its own; anything above escalates.
  maxDiscountPercent: 10,
  // Quotes above this total (or with any discount) wait for staff approval.
  autoApproveLimit: 50000,
  quoteValidDays: 14,
  // Free-form guidance staff can give the agent (tone, policies, upsells...).
  agentInstructions:
    "Be practical and concise. If site conditions or delivery distance are missing, ask before quoting. " +
    "Suggest joint sand for paving jobs and sealer for driveways.",
  // Shown on the quotation document.
  companyTagline: "Quality products | Expert advice | A stronger tomorrow",
  companyAddress: "3 Kalika St, Vulindlela Heights\nMthatha, 5100\nSouth Africa",
  companyPhone: "047 532 5404",
  companyEmail: "",
  companyWebsite: "",
  quotePrefix: "BBS",
  quoteSubtitle: "Paving solutions for homes & businesses",
  quoteSignatory: "",
  quoteSignatoryTitle: "Sales Consultant",
  // One per line. {days} is replaced with the quote validity.
  quoteTerms: [
    "This quotation is valid for {days} days from the issue date.",
    "Prices are subject to final site inspection and confirmation of quantities.",
    "Any additional work not stated in this quotation will be charged separately.",
    "Client to ensure clear access for delivery and installation.",
    "Final approval and a signed purchase order are required to proceed.",
    "All work will be carried out in accordance with industry best practices and manufacturer guidelines.",
  ].join("\n"),
};

// Accessories sold alongside bricks and pavers. The agent adds these as extras.
export const defaultCatalog = [
  {
    sku: "SAND-RIV",
    name: "River sand (bedding / joints)",
    description: "Washed river sand for paver bedding and jointing.",
    unit: "m³",
    unitPrice: 480,
    minQuantity: 0.5,
    volumeTiers: [{ minQuantity: 6, discountPercent: 8 }],
  },
  {
    sku: "SAND-BLD",
    name: "Building sand",
    description: "Sand for brick mortar.",
    unit: "m³",
    unitPrice: 420,
    minQuantity: 0.5,
    volumeTiers: [{ minQuantity: 6, discountPercent: 8 }],
  },
  {
    sku: "CEM-50",
    name: "Cement 42.5N (50 kg)",
    description: "General purpose cement for mortar and kerb bedding.",
    unit: "bag",
    unitPrice: 115,
    minQuantity: 1,
    volumeTiers: [{ minQuantity: 40, discountPercent: 5 }],
  },
  {
    sku: "EDGE-KRB",
    name: "Concrete edge kerb",
    description: "Edge restraint for paving, per running metre.",
    unit: "metre",
    unitPrice: 85,
    minQuantity: 1,
  },
  {
    sku: "SEAL-PAV",
    name: "Paver sealer (5 L, covers ~25 m²)",
    description: "Water-based sealer for concrete and clay pavers.",
    unit: "5 L tin",
    unitPrice: 650,
    minQuantity: 1,
  },
];

// Rate card for brick, paver and other product jobs. All prices are made-up
// placeholders until the real ones are confirmed.
//
// Each product is priced per unit of sale (`unit`). Sizes are L × W × H in mm;
// `sizeVerified: false` means the size is a typical size, still to be confirmed.
// `coveragePerM2` is the published catalogue coverage rate and always wins over
// a coverage estimated from the size. `layout` says which face covers the area:
// "wall" uses length × height, "paving" uses length × width.
const size = (lengthMm, widthMm, heightMm) => ({ lengthMm, widthMm, heightMm });
const STD_BRICK = size(222, 106, 73);
const brick = (name, unitPrice, extra = {}) => ({
  name,
  category: "brick",
  unit: "brick",
  unitPrice,
  layout: "wall",
  size: STD_BRICK,
  sizeVerified: false,
  coveragePerM2: null,
  weightKg: 3,
  unitsPerPallet: 500,
  labour: { basis: "area", rate: 180 },
  ...extra,
});
const face = (name, unitPrice, colour, finish) =>
  brick(name, unitPrice, { colour, finish, weightKg: 2.9, labour: { basis: "area", rate: 220 } });
const bosun = (name, unitPrice, colour, sz, coveragePerM2, weightKg, unitsPerPallet, labourRate) => ({
  name,
  category: "paver",
  unit: "paver",
  unitPrice,
  layout: "paving",
  size: sz,
  sizeVerified: true,
  coveragePerM2,
  colour,
  weightKg,
  unitsPerPallet,
  labour: { basis: "area", rate: labourRate },
});
const clayPaver = (name, unitPrice, colour) => ({
  name,
  category: "paver",
  unit: "paver",
  unitPrice,
  layout: "paving",
  size: size(222, 106, 50),
  sizeVerified: false,
  coveragePerM2: null,
  colour,
  weightKg: 2.3,
  unitsPerPallet: 500,
  labour: { basis: "area", rate: 110 },
});
const other = (name, unit, unitPrice, weightKg, unitsPerPallet, labour, extra = {}) => ({
  name,
  category: "other",
  unit,
  unitPrice,
  layout: null,
  size: null,
  sizeVerified: false,
  coveragePerM2: null,
  weightKg,
  unitsPerPallet,
  labour,
  ...extra,
});
const CONCRETE_COLOURS = ["grey", "red", "charcoal", "black", "tan"];

export const defaultRates = {
  products: {
    // ---- Bricks and blocks ----
    clay_stock: brick("Clay Stock Brick", 3.2, { colour: "Red", finish: "Stock" }),
    stock_perforated_elb2: brick("Stock Perforated ELB2", 2.85, { colour: "Red", finish: "Stock", weightKg: 2.6 }),
    cement_stock: brick("Cement Stock Brick", 2.4, {
      weightKg: 3.4,
      colourOptions: CONCRETE_COLOURS,
      finishOptions: ["standard", "rockface"],
    }),
    addo_plaster_solid: brick("Addo Plaster Solid", 3.1, { colour: "Red", finish: "Plaster" }),
    addo_solid_klinker: brick("Addo Solid Klinker", 4.6, { colour: "Dark klinker", finish: "Klinker", weightKg: 3.2 }),
    agate_satin_fbx: face("Agate Satin FBX", 9.8, "Agate", "Satin"),
    agate_travertine: face("Agate Travertine", 10.4, "Agate", "Travertine"),
    firelight_satin: face("Firelight Satin", 9.2, "Firelight", "Satin"),
    firelight_travertine_fbx: face("Firelight Travertine FBX", 10.1, "Firelight", "Travertine"),
    silvergrey_satin: face("Silvergrey Satin", 9.6, "Silvergrey", "Satin"),
    cathcart_travertine_fbs: face("Cathcart Travertine FBS", 8.9, "Cathcart", "Travertine"),
    country_classic_satin: face("Country Classic Satin", 8.4, "Country Classic", "Satin"),
    golden_wheat_travertine: face("Golden Wheat Travertine", 9.9, "Golden Wheat", "Travertine"),
    roan_travertine_fbx: face("Roan Travertine FBX", 10.2, "Roan", "Travertine"),
    mvuba_clay_maxi: brick("Mvuba Clay Maxi", 6.8, {
      colour: "Red",
      finish: "Stock",
      size: size(290, 140, 90),
      weightKg: 5.5,
      unitsPerPallet: 280,
    }),
    m6_block: {
      name: "M6 Concrete Building Block",
      category: "block",
      unit: "block",
      unitPrice: 14.5,
      layout: "wall",
      size: size(390, 140, 195), // listed as 390 × 195 × 140 (L × H × W)
      sizeVerified: true,
      coveragePerM2: null,
      colourOptions: ["grey", "charcoal"],
      finishOptions: ["standard", "rockface"],
      weightKg: 15,
      unitsPerPallet: 60,
      labour: { basis: "area", rate: 160 },
    },

    // ---- Pavers ----
    bosun_bond_grey: bosun("Bosun Bond Grey", 3.1, "Grey", size(200, 100, 50), 50, 2.2, 528, 95),
    bosun_bond_red: bosun("Bosun Bond Red", 3.4, "Red", size(200, 100, 50), 50, 2.2, 528, 95),
    bosun_bond_black: bosun("Bosun Bond Black", 3.6, "Black", size(200, 100, 50), 50, 2.2, 528, 95),
    bosun_interlock_grey: bosun("Bosun Interlock Grey", 3.7, "Grey", size(200, 100, 60), 50, 2.6, 480, 100),
    bosun_interlock_red: bosun("Bosun Interlock Red", 4.0, "Red", size(200, 100, 60), 50, 2.6, 480, 100),
    bosun_interlock_black: bosun("Bosun Interlock Black", 4.2, "Black", size(200, 100, 60), 50, 2.6, 480, 100),
    bosun_ethnic_smooth_grey: bosun("Bosun Ethnic Smooth Grey", 6.4, "Grey", size(200, 150, 55), 33, 3.6, 330, 105),
    bosun_ethnic_smooth_red: bosun("Bosun Ethnic Smooth Red", 6.8, "Red", size(200, 150, 55), 33, 3.6, 330, 105),
    bosun_grass_block_grey: bosun("Bosun Grass Block Grey", 42, "Grey", size(600, 400, 100), 4.2, 30, 28, 120),
    bosun_urban_large_grey: bosun("Bosun Urban Large Grey", 38.5, "Grey", size(400, 300, 60), 8, 16.6, 72, 130),
    bosun_urban_large_black: bosun("Bosun Urban Large Black", 41, "Black", size(400, 300, 60), 8, 16.6, 72, 130),
    autumn_clay_paver: clayPaver("Autumn Clay Paver", 7.2, "Autumn blend"),
    nutmeg_clay_paver: clayPaver("Nutmeg Clay Paver", 7.4, "Nutmeg"),
    rustic_blend_clay_paver: clayPaver("Rustic Blend Clay Paver", 7.6, "Rustic blend"),
    platinum_clay_paver: clayPaver("Platinum Clay Paver", 8.2, "Platinum"),

    // ---- Other products ----
    natural_stone_tiles: other("Natural stone tiles", "m²", 395, 30, 20, { basis: "quantity", rate: 260 }),
    natural_stone_cladding: other("Natural stone cladding", "m²", 545, 45, 15, { basis: "quantity", rate: 320 }),
    smartstone_paving: other("SmartStone paving", "m²", 465, 45, 25, { basis: "quantity", rate: 180 }),
    smartstone_coping: other("SmartStone coping", "metre", 310, 20, 30, { basis: "quantity", rate: 140 }),
    vinyl_flooring: other("Vinyl flooring", "m²", 289, 6, 40, { basis: "quantity", rate: 95 }),
    retaining_blocks: other("Retaining blocks", "unit", 38, 28, 40, { basis: "quantity", rate: 55 }, {
      colourOptions: CONCRETE_COLOURS,
      finishOptions: ["standard", "rockface"],
    }),
    concrete_slabs: other("Concrete slabs (450 × 450 × 40 mm)", "unit", 62, 18, 60, { basis: "area", rate: 90 }, {
      layout: "paving",
      size: size(450, 450, 40),
      colourOptions: CONCRETE_COLOURS,
      finishOptions: ["standard"],
    }),
    garden_edging: other("Garden edging", "unit", 24, 9, 120, { basis: "quantity", rate: 12 }, {
      colourOptions: CONCRETE_COLOURS,
      finishOptions: ["standard"],
    }),
  },
  // Surcharges per unit of sale. They only apply to products where the colour
  // or finish is a choice (colourOptions/finishOptions); when the colour or
  // finish is part of the SKU, its price already includes it.
  colours: {
    grey: { name: "Grey", surcharge: 0 },
    red: { name: "Red", surcharge: 0.4 },
    charcoal: { name: "Charcoal", surcharge: 0.6 },
    black: { name: "Black", surcharge: 0.75 },
    tan: { name: "Tan / Sandstone", surcharge: 0.5 },
    autumn_blend: { name: "Autumn Blend", surcharge: 0.9 },
  },
  finishes: {
    standard: { name: "Standard", surcharge: 0 },
    satin: { name: "Satin finish", surcharge: 0.8 },
    travertine: { name: "Travertine finish", surcharge: 1.1 },
    rockface: { name: "Rockface finish", surcharge: 1.5 },
  },
  wastageOptions: [
    { name: "No wastage", percent: 0 },
    { name: "Low wastage", percent: 3 },
    { name: "Standard allowance", percent: 5 },
    { name: "High wastage", percent: 10 },
  ],
  // Mortar joints used when coverage is estimated from the size.
  jointMm: { wall: 10, paving: 3 },
  pallets: {
    fullPalletFee: 60, // strapping and wrapping, per full pallet
    partialPalletFee: 95, // breaking bulk, per part pallet
    deposit: 250, // per pallet
    returnCredit: 200, // per pallet the customer will return
    additionalPackingPerPallet: 75, // shrink wrap and edge protectors
  },
  delivery: {
    // Charge per trip by one-way distance, before the vehicle factor.
    brackets: [
      { upToKm: 10, charge: 450 },
      { upToKm: 25, charge: 750 },
      { upToKm: 50, charge: 1200 },
      { upToKm: 100, charge: 2100 },
    ],
    beyond100PerKm: 18, // added per km over 100
    maxDistanceKm: 250, // further than this is a custom quote
    vehicles: {
      truck_1t: { name: "1-ton truck", capacityKg: 1000, pallets: 1, baseFee: 350, distanceFactor: 0.8, crane: false },
      truck_3t: { name: "3-ton truck", capacityKg: 3000, pallets: 3, baseFee: 600, distanceFactor: 1, crane: false },
      truck_5t: { name: "5-ton truck", capacityKg: 5000, pallets: 5, baseFee: 850, distanceFactor: 1.2, crane: false },
      crane_8t: { name: "8-ton crane truck", capacityKg: 8000, pallets: 8, baseFee: 1450, distanceFactor: 1.5, crane: true },
      crane_30t: { name: "30-ton crane truck", capacityKg: 30000, pallets: 24, baseFee: 3800, distanceFactor: 2.5, crane: true },
      third_party: { name: "Third-party logistics", capacityKg: 34000, pallets: 28, baseFee: 2950, distanceFactor: 3, crane: false },
    },
  },
  offloading: {
    standard: { name: "Standard offloading", perTrip: 150, perPallet: 0 },
    crane: { name: "Crane offloading", perTrip: 450, perPallet: 0, needsCrane: true },
    forklift: { name: "Forklift required", perTrip: 650, perPallet: 0 },
    manual: { name: "Manual offloading", perTrip: 0, perPallet: 180 },
  },
  difficultAccess: { perTrip: 450, labourFactor: 1.2 },
  waitingPerHour: 380,
  slope: {
    flat: { name: "Flat", factor: 1 },
    gentle: { name: "Gentle slope", factor: 1.1 },
    steep: { name: "Steep slope", factor: 1.25 },
  },
  // Only charged when installation is included.
  groundPrep: {
    none: { name: "None (prepared base)", perM2: 0 },
    light: { name: "Level and compact", perM2: 45 },
    full: { name: "Excavate, sub-base and bedding", perM2: 185 },
  },
  minimumLabourCharge: 2500,
  // Discounts apply to materials only, not delivery, packaging or labour.
  discounts: {
    standard: { name: "Standard customer", percent: 0 },
    contractor: { name: "Contractor", percent: 7.5 },
    bulk: { name: "Bulk purchase", percent: 5, minMaterials: 15000 },
    negotiated: { name: "Negotiated", percent: null }, // entered per quote, up to the max discount setting
  },
};
