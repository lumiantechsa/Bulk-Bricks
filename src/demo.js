// Public demo mode. Anyone can press "Try the demo" without signing in and
// gets a private sandbox: its own set of tables (a schema in a separate
// in-memory database), filled with the example price list and sample
// quotations. Demo requests are answered by an app instance bound to that
// sandbox, so they can never read or change the real database, staff or
// quotations. Sandboxes are deleted after a period of inactivity.
import crypto from "node:crypto";
import { openSandboxHost, openSchemaDatabase } from "./db.js";
import { createStore } from "./store.js";

const DEMO_TOKEN = /^Bearer demo\.([a-f0-9]{16})\.([a-f0-9]{64})$/i;

// A finished example job, used for the sample quotations.
const sampleJob = (materials, extra = {}) => ({
  materials: materials.map((m) => ({
    colour: "", finish: "", useCustomSize: false, lengthMm: 0, widthMm: 0, heightMm: 0,
    quantityMode: "units", wastagePercent: 5, ...m,
  })),
  deliveryDistanceKm: 18, otherProvince: false, vehicle: "auto", offloading: "standard", difficultAccess: false,
  waitingHours: 0, returnPallets: false, additionalPacking: false, includeLabour: false, slope: "flat",
  groundPrep: "none", customerType: "standard", negotiatedPercent: 0, ...extra,
});

async function seedSandbox(store, user) {
  await store.updateSettings({
    quotePrefix: "DEMO",
    agentInstructions:
      "This is a public demo with example products and prices. Be practical and concise. " +
      "Suggest joint sand for paving jobs and sealer for driveways.",
  }, user);
  const samples = [
    {
      status: "sent",
      input: {
        customer: { name: "Thandi Mokoena", company: "Example: Sunrise Builders", email: "thandi@example.com" },
        projectName: "Driveway paving", siteAddress: "12 Example Street, Beacon Bay",
        projectSummary: "Supply and installation of red interlocking pavers for a driveway.",
        job: sampleJob([{ productKey: "bosun_interlock_red", quantityMode: "area", quantity: 60 }], { includeLabour: true, groundPrep: "light" }),
        extras: [{ sku: "SAND-RIV", quantity: 3 }],
      },
    },
    {
      status: "draft",
      input: {
        customer: { name: "Pieter van Wyk", company: "Example: Coastal Homes" },
        projectName: "Boundary wall",
        job: sampleJob([
          { productKey: "agate_satin_fbx", quantity: 4000 },
          { productKey: "m6_block", colour: "grey", finish: "standard", quantity: 300 },
        ], { customerType: "contractor" }),
      },
    },
  ];
  for (const s of samples) {
    await store.quotations.create({ input: s.input, status: s.status, user, summary: "Sample quotation for the demo" });
  }
}

/**
 * @param {{createApp: Function, getClient: Function, provider: string, maxSandboxes?: number,
 *   idleMinutes?: number, maxAiCalls?: number, startsPerHour?: number}} options
 */
export function createDemo({ createApp, getClient, provider, maxSandboxes = 40, idleMinutes = 120, maxAiCalls = 60, startsPerHour = 10 }) {
  const sandboxes = new Map(); // id -> { app, db, lastUsed, aiCalls }
  const startsByIp = new Map(); // ip -> timestamps
  let host = null;

  const close = async (id) => {
    const s = sandboxes.get(id);
    if (!s) return;
    sandboxes.delete(id);
    await s.db.close().catch((err) => console.error("Closing demo sandbox failed", err.message));
  };

  // Remove idle sandboxes.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMinutes * 60_000;
    for (const [id, s] of sandboxes) if (s.lastUsed < cutoff) close(id);
  }, 60_000);
  sweep.unref();

  async function start(req, res) {
    const ip = req.ip ?? "unknown";
    const recent = (startsByIp.get(ip) ?? []).filter((t) => t > Date.now() - 3_600_000);
    if (recent.length >= startsPerHour) {
      return res.status(429).json({ error: "Too many demos started from here. Please try again later." });
    }
    if (sandboxes.size >= maxSandboxes) {
      // Make room by closing the least recently used sandbox if it's been idle a while.
      const oldest = [...sandboxes.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest && oldest[1].lastUsed < Date.now() - 10 * 60_000) await close(oldest[0]);
      else return res.status(503).json({ error: "The demo is busy right now. Please try again in a few minutes." });
    }
    recent.push(Date.now());
    startsByIp.set(ip, recent);

    host ??= openSandboxHost();
    const id = crypto.randomBytes(8).toString("hex");
    const db = await openSchemaDatabase(await host, `demo_${id}`);
    try {
      const store = await createStore(db);
      const password = crypto.randomBytes(24).toString("hex");
      const user = await store.auth.ensureAccount({ username: "demo", name: "Demo visitor", password, role: "admin" });
      await seedSandbox(store, user);
      const { token } = await store.auth.login("demo", password);
      sandboxes.set(id, { app: createApp({ store, getClient, provider, demoMode: true }), db, lastUsed: Date.now(), aiCalls: 0 });
      res.status(201).json({ token: `demo.${id}.${token}` });
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
  }

  // Requests with a demo token go to that visitor's sandbox app, never to the real one.
  function gate(req, res, next) {
    const m = DEMO_TOKEN.exec(req.get("authorization") ?? "");
    if (!m) {
      if (/^Bearer demo\./i.test(req.get("authorization") ?? "")) {
        return res.status(401).json({ error: "This demo has ended. Start a new one.", demoExpired: true });
      }
      return next();
    }
    const sandbox = sandboxes.get(m[1]);
    if (!sandbox) return res.status(401).json({ error: "This demo has ended. Start a new one.", demoExpired: true });
    sandbox.lastUsed = Date.now();
    // The demo uses the real AI service, so each sandbox gets a fair-use allowance.
    const usesAi = req.method === "POST" && /^\/api\/(chat\/[^/]+\/(messages|job)|products\/extract)$/.test(req.originalUrl.split("?")[0]);
    if (usesAi && ++sandbox.aiCalls > maxAiCalls) {
      return res.status(429).json({ error: "This demo has reached its limit of assistant requests. Start a new demo to continue." });
    }
    req.headers.authorization = `Bearer ${m[2]}`;
    req.url = req.originalUrl;
    sandbox.app(req, res, next);
  }

  return {
    start,
    gate,
    sandboxCount: () => sandboxes.size,
    async closeAll() {
      clearInterval(sweep);
      for (const id of [...sandboxes.keys()]) await close(id);
      if (host) {
        const closing = host;
        host = null;
        await (await closing).close();
      }
    },
  };
}
