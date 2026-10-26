import crypto from "node:crypto";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/store.js";

// Scripted stand-in for the Anthropic client: each call returns the next response.
export function fakeClient(script) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error("No scripted response left");
          return typeof next === "function" ? next(params) : next;
        },
      },
    },
  };
}

// OpenAI Chat Completions stand-in.
export function fakeOpenAI(script) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        async create(params) {
          calls.push(structuredClone(params));
          const next = script.shift();
          return { choices: [{ message: typeof next === "function" ? next(params) : next }] };
        },
      },
    },
  };
}

export const toolUse = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
export const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

/**
 * An empty database: in-memory PGlite, or with TEST_DATABASE_URL a fresh
 * database on that PostgreSQL server (to test the production driver).
 */
async function testDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: await openDatabase({}), drop: async () => {} };
  const { default: pg } = await import("pg");
  const name = `quote_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const db = await openDatabase({ url: testUrl.toString() });
  return {
    db,
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * Starts the app on an in-memory database with an administrator ("admin") and
 * a salesperson ("sam"). `req` signs requests as `as: "admin" | "sam" | token`.
 */
export async function startServer(client, provider = "anthropic") {
  const { db, drop } = await testDatabase();
  const store = await createStore(db);
  await store.auth.bootstrap({ username: "admin", password: "admin-password" });
  const app = createApp({ store, getClient: () => client, provider });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};
  const req = async (path, { token, as, ...opts } = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: {
        "content-type": "application/json",
        ...(token && { "x-conversation-token": token }),
        ...(as && { authorization: `Bearer ${tokens[as] ?? as}` }),
      },
    });
    return { status: res.status, body: await res.json() };
  };
  const login = async (username, password) => (await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })).body.token;
  tokens.admin = await login("admin", "admin-password");
  await req("/api/staff", { method: "POST", as: "admin", body: JSON.stringify({ username: "sam", name: "Sam Sales", role: "sales", password: "sam-password" }) });
  tokens.sam = await login("sam", "sam-password");
  const close = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
    await drop();
  };
  return { store, server, req, base, tokens, close };
}

export const brickJob = {
  productKey: "clay_stock", colour: "", finish: "", useCustomSize: false, lengthMm: 0, widthMm: 0, heightMm: 0,
  quantityMode: "units", quantity: 1000, wastagePercent: 5, deliveryDistanceKm: 0, otherProvince: false,
  vehicle: "auto", offloading: "standard", difficultAccess: false, waitingHours: 0, returnPallets: false,
  additionalPacking: false, includeLabour: false, slope: "flat", groundPrep: "none", customerType: "standard",
  negotiatedPercent: 0,
};
// The same job as the form sends it: a list of materials plus the shared fields.
const { productKey, colour, finish, useCustomSize, lengthMm, widthMm, heightMm, quantityMode, quantity, wastagePercent, ...shared } = brickJob;
export const formJob = {
  materials: [{ productKey, colour, finish, useCustomSize, lengthMm, widthMm, heightMm, quantityMode, quantity, wastagePercent }],
  ...shared,
};
