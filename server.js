import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createApp } from "./src/app.js";
import { openDatabase } from "./src/db.js";
import { createStore } from "./src/store.js";
import { modelFor } from "./src/agent.js";
import { createDemo } from "./src/demo.js";

const port = Number(process.env.PORT) || 3000;

// LLM_PROVIDER wins; otherwise use whichever API key is configured (OpenAI first).
const provider =
  process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY ? "openai" : "anthropic");
if (!["openai", "anthropic"].includes(provider)) {
  throw new Error(`LLM_PROVIDER must be "openai" or "anthropic", got "${provider}"`);
}
if (provider === "openai" && !process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set: the agent can't reply until it is.");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.warn(
    `DATABASE_URL is not set: using the embedded database in ${process.env.PGLITE_DIR || "./data/pglite"}. Fine for one machine; ` +
      "on Railway attach a Postgres database (or use a Supabase connection string) so data survives redeploys.",
  );
}
const db = await openDatabase({ url: databaseUrl, dir: process.env.PGLITE_DIR || "./data/pglite" });
const store = await createStore(db, { legacyFile: process.env.DATA_FILE || "./data/db.json" });

if (!(await store.auth.bootstrap({ username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD }))) {
  const users = await store.auth.listUsers();
  if (!users.length) console.warn("No staff accounts yet: set ADMIN_PASSWORD to create the first administrator.");
}

// Shared sign-in requested by the owner: username "Test", password "Test"
// (usernames are not case-sensitive). Created once; change its password under
// My account and it stays changed.
if (await store.auth.ensureAccount({ username: "Test", name: "Test", password: "Test", role: "admin" })) {
  console.log('Created the administrator sign-in "Test" (password "Test").');
}

let client;
const getClient = () => (client ??= provider === "openai" ? new OpenAI() : new Anthropic());

// Public demo with example data in isolated sandboxes. DEMO_MODE=off turns it off.
const demo = process.env.DEMO_MODE === "off" ? null : createDemo({ createApp, getClient, provider });

createApp({ store, getClient, provider, demo }).listen(port, () => {
  console.log(`Bulkbrick Supplies quoting system (${provider}, ${modelFor(provider)}, ${db.kind}) running:`);
  console.log(`  Quoting assistant: http://localhost:${port}/`);
  console.log(`  Quotations, pricing and staff: http://localhost:${port}/admin`);
  if (demo) console.log(`  Public demo (no sign-in): http://localhost:${port}/?demo`);
});
