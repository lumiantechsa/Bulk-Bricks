# Profile Brick & Tile quoting system

An internal quotation system for a brick, paving and tile supplier. Employees sign in and use three connected sections, all in the left sidebar:

- **AI Quoting Assistant** (`/`): a job form next to a chat. Staff enter the job and get an itemised quote straight away; the assistant reviews it, collects the customer's details and issues the quote.
- **Quotations** (`/admin#quotations`): every quotation the assistant prices is saved automatically as a card. Employees can search the cards, open one, change anything, recalculate, save, regenerate the branded PDF, refresh it to current prices or delete it.
- **Pricing Management** (`/admin#pricing`): the single price list for products, prices and pricing variables. Changes are saved centrally and reach every open screen within a second.

Managers also get **Overview**, **Assistant chats** (take over a chat and reply), **Employees** (accounts and permissions), **Activity log** and **Company settings**.

## Running it

```bash
npm install
cp .env.example .env    # fill in OPENAI_API_KEY, ADMIN_PASSWORD and (for production) DATABASE_URL
npm start               # reads .env automatically (Node 22.9+)
```

Open http://localhost:3000 and sign in with username **Test** and password **Test** (an administrator created on the first start; usernames aren't case-sensitive). Change that password under **My account**: it is only set once, so your change sticks. `admin` with `ADMIN_PASSWORD` is also created when the database is empty. Then add employees under **Employees**.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Railway Postgres, Supabase or any Postgres). **Set this in production.** Without it, an embedded Postgres (PGlite) stores data in `./data/pglite`, which only suits a single machine with a persistent disk |
| `ADMIN_PASSWORD` | Password of the first administrator, used once on the first start when there are no accounts |
| `ADMIN_USERNAME` | Username of that administrator (default `admin`) |
| `LLM_PROVIDER` | `openai` or `anthropic`. If unset, OpenAI is used when `OPENAI_API_KEY` is set |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI key and model (default `gpt-5.5`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Claude key and model (default `claude-opus-5-5`) |
| `PORT` | HTTP port (default `3000`) |
| `DEMO_MODE` | `off` turns off the public demo (on by default) |
| `DATA_FILE` | The JSON data file from the earlier version. If it exists, its settings, rate-card prices, accessories and quotes are imported once on the first start |

The database schema is created and upgraded automatically on start (`migrations/*.sql`).

### Deploying on Railway

1. In the Railway project, add a **PostgreSQL** database.
2. On the app service, add the variable `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`. A Supabase connection string also works.
3. Keep `ADMIN_PASSWORD` and the LLM key as before. Railway deploys the default branch automatically.

Several server instances can share one database: changes are broadcast with PostgreSQL `LISTEN/NOTIFY`, so every instance pushes them to its users.

## Public demo

Anyone can try the system without an account. The sign-in page has a **Try the demo** button, and a link ending in `?demo` (e.g. `https://your-site/?demo`) opens the demo straight away. Every visitor gets a private sandbox:

- **Example data only.** The sandbox is filled with the example price list (`src/defaults.js`) and two sample quotations numbered `DEMO-…`. The visitor never sees the real products, prices, quotations or employees.
- **Fully isolated.** Each sandbox is its own set of tables in a separate in-memory database, never the real one. Requests with a demo token are answered by an app bound to that sandbox, so whatever the visitor adds, edits or deletes can't reach the real system or other visitors.
- **Clearly marked.** A red banner says it's a demo, with an **Exit demo** button.
- **Temporary.** A sandbox is deleted after 2 hours without use. There are at most 40 at a time and 10 starts per hour from one address, and each sandbox gets 60 assistant requests, since the demo uses the real AI service.

Set `DEMO_MODE=off` to turn the demo off.

## Staff and permissions

Everyone signs in with their own account. Permissions are checked by the server on every request; the interface only hides what someone can't do.

| | Administrator | Sales employee |
|---|---|---|
| Create quotations, use the assistant, view and edit saved quotations, generate PDFs | ✓ | ✓ |
| View the approved price list | ✓ | ✓ |
| Manage products, prices and pricing variables (`manage_pricing`) | ✓ | only if granted |
| Change line-item prices and add manual lines (`override_prices`) | ✓ | only if granted |
| Approve or decline quotations; edit accepted ones (`approve_quotations`) | ✓ | only if granted |
| Delete and restore quotations (`delete_quotations`) | ✓ | only if granted |
| Supervise assistant chats (`supervise_chats`) | ✓ | only if granted |
| Manage employees (`manage_staff`) | ✓ | only if granted |

Passwords are hashed with scrypt; sessions last 7 days and end when someone is disabled or their password changes. Repeated failed sign-ins are slowed down.

## Pricing Management

**Products.** Every product the assistant can quote is a database record with a name, category, code (SKU), description, unit, selling price (excl. VAT), VAT treatment (standard, zero-rated, exempt) and active status. The fields depend on the category:

- *Materials* (bricks, blocks, paving, natural stone, flooring, other): dimensions, units per pallet, weight, coverage per m², how it's laid, default wastage, colour/finish (built in, or a choice with surcharges), installation labour rate and basis, and delivery requirements (forklift or crane offloading).
- *Accessories and services* (sand, cement, sealer, delivery or labour services): minimum quantity and volume discounts. They're added to quotes as extras.

Saving shows a confirmation and every open screen updates at once. Every price change is kept in the product's **price history**: previous price, new price, who changed it and when. Two people saving the same product at once can't overwrite each other: the second save is refused and shows the other person's version.

**Add product with AI.** Describe a product in plain words, e.g. *"Add a new charcoal paving brick, 200 by 100 by 50 millimetres, costing R7.50 each, with 500 bricks per pallet."* The assistant picks the category and fills in the form for you to check. It never invents figures: any number it returns that doesn't appear in your description is discarded, and required fields that are still empty (here, the weight per brick) are highlighted. Nothing is saved until you complete the form and press Save. The product is then selectable in the assistant straight away.

**Pricing variables.** Everything the calculator uses besides product prices: delivery distance brackets and the cost per km beyond them, vehicles (capacity, pallets, base fee, distance factor, crane), offloading methods including forklift and crane charges, pallet fees, deposit and return credit, difficult-access and waiting charges, slope factors, ground preparation, the minimum labour charge, customer discounts, colour and finish surcharges and wastage options. Staff can edit them, add new ones (a new vehicle, bracket or colour) and deactivate them; the calculator always keeps at least one of each kind it needs.

**Custom adjustments** let staff add their own charges without code. Each has a name, data type (amount, percentage or number), value, unit, the product categories it applies to, and one of these fixed rules: per unit, per m², percentage of the matching products, per pallet, per delivery trip, once per quotation, or reference only. No formulas or AI-generated code are ever run.

**Quotation limits** (VAT rate, maximum negotiated discount, the approval threshold) are on the same page.

## Quotations

Each time the assistant prices a job (from the form or the chat), the job is saved as a **draft quotation** with a number such as `PB&T-2026-0001`. When the assistant issues the quote, that same record becomes a formal quotation. Cards show the number, customer, dates created and updated, total, status and the employee responsible. They can be searched by number, customer, company, project or employee, and filtered by status.

A quotation stores its full structure in the database: customer, project details, the job (materials, quantities, wastage, delivery, offloading, labour, discount), extras, manual lines, price changes, notes, every line item, totals, and a **snapshot of the price list it was priced with**. Quotations stay until an authorised employee deletes them. "New chat" in the assistant clears the chat only; its quotations remain.

**Editing.** Opening a card shows the same job form as the assistant plus customer details, extras, line items and notes. Totals recalculate as you type. Staff with `override_prices` can change any line's unit price (e.g. delivery or labour) and add manual lines; the original price stays visible. **Save changes** saves a new revision, and **Regenerate PDF** makes the branded quotation from the saved version (it offers to save first). **Revisions** lists every saved version with who saved it, and each can be viewed.

**Original prices.** Price-list changes never alter saved quotations. Edits are recalculated with the quotation's own snapshot. A product added to an old quotation is priced at today's price and added to its snapshot. **Refresh using current prices** shows each line's saved and current price and the new totals, and only replaces the saved prices after you confirm.

**Simultaneous editing.** Every save carries the version it was based on. If someone else saved in the meantime, the save is refused and nothing is overwritten. Anyone with the quotation open is told straight away.

**Approval.** Quotes above the approval threshold or with a negotiated discount wait for a manager. If an approved quote is edited by someone without approval rights and now needs approval, it goes back to "awaiting approval". Accepted quotations can only be changed by a manager.

**Deleting** asks for confirmation and moves the quotation to the bin. It disappears from everyone's list and can't be opened by people without `delete_quotations`, who can see the bin and restore it.

## How it works

```
Browser (assistant, quotations, pricing) ──► Express API ──► PostgreSQL
            ▲                                  │   ▲             │
            └──── live updates (SSE) ◄─────────┘   └── LISTEN/NOTIFY
```

- `src/pricing.js` is the only place prices are calculated. The AI never does arithmetic or sets prices: it can only pass product keys and quantities to the tools, and every number comes from the database and these deterministic functions. Money is stored as `numeric` and rounded to whole cents.
- `src/catalog.js` and `src/variables.js` build the rate card from the products and pricing-variable tables.
- `src/quotations.js` saves quotations, line items, revisions and price snapshots, with version checks.
- `src/auth.js` handles accounts, sessions and permissions. `src/store.js` holds settings, chats, the audit log and change events. `src/db.js` connects to Postgres (or PGlite) and runs migrations.
- `src/agent.js` and `src/tools.js` are the assistant (OpenAI or Claude) with six tools: `list_catalog`, `set_job_details`, `calculate_quote`, `save_customer_details`, `submit_quote` and `escalate_to_human`. `src/productAi.js` is the product-entry assistant.

The **Activity log** records sign-ins, product, price and variable changes, quotation creation, edits, status changes, PDF generation, deletion and restoration, settings changes and staff changes, with who and when.

## Tests

```bash
npm test                                             # embedded database
TEST_DATABASE_URL=postgres://user:pass@host/db npm test   # a real PostgreSQL server (one throwaway database per test)
```

The tests cover the pricing rules, the assistant flows against scripted OpenAI and Claude clients (no API key needed), and the upgrade's acceptance scenarios: live price updates with saved quotations keeping their prices, AI product entry that won't invent figures, shared editing with conflict detection, PDF data after edits, deletion and the bin, backend permission checks, pricing variables and the import of the old data file. CI runs them against both databases.
