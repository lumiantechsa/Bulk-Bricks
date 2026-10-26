// Staff accounts, sign-in sessions and role-based permissions. Every API
// route checks permissions on the server; the UI only hides what a user can't do.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { HttpError } from "./catalog.js";

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 7;

export const PERMISSIONS = {
  manage_pricing: "Manage products, prices and pricing variables",
  override_prices: "Change line-item prices and add manual lines on quotations",
  approve_quotations: "Approve or decline quotations, and edit accepted ones",
  delete_quotations: "Delete and restore quotations",
  supervise_chats: "See every assistant chat, take over and reply as a manager",
  manage_staff: "Manage employees and their permissions",
};

export const ROLES = {
  admin: { label: "Administrator", permissions: Object.keys(PERMISSIONS) },
  sales: { label: "Sales employee", permissions: [] },
};

export const userPermissions = (user) =>
  [...new Set([...(ROLES[user.role]?.permissions ?? []), ...(user.permissions ?? [])])].filter((p) => PERMISSIONS[p]);

export const can = (user, permission) => !!user && userPermissions(user).includes(permission);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = await scrypt(String(password), Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const iso = (d) => (d instanceof Date ? d.toISOString() : d);

export const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  email: u.email,
  role: u.role,
  roleLabel: ROLES[u.role]?.label ?? u.role,
  extraPermissions: u.permissions ?? [],
  permissions: userPermissions(u),
  active: u.active,
  createdAt: iso(u.created_at),
});

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    throw new HttpError(400, "Passwords need at least 8 characters.");
  }
}

function checkUserFields(input, { creating }) {
  const out = {};
  if (creating || input.username !== undefined) {
    out.username = String(input.username ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._@-]{2,60}$/.test(out.username)) {
      throw new HttpError(400, "Username: 2–60 letters, digits, dots, dashes, @ or underscores.");
    }
  }
  if (creating || input.name !== undefined) {
    out.name = String(input.name ?? "").trim();
    if (!out.name || out.name.length > 80) throw new HttpError(400, "Name is required (up to 80 characters).");
  }
  if (input.email !== undefined) out.email = String(input.email).trim().slice(0, 120);
  if (creating || input.role !== undefined) {
    if (!ROLES[input.role]) throw new HttpError(400, `Role must be one of: ${Object.keys(ROLES).join(", ")}.`);
    out.role = input.role;
  }
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions) || input.permissions.some((p) => !PERMISSIONS[p])) {
      throw new HttpError(400, `Permissions must be from: ${Object.keys(PERMISSIONS).join(", ")}.`);
    }
    out.permissions = [...new Set(input.permissions)];
  }
  if (input.active !== undefined) out.active = !!input.active;
  return out;
}

export function createAuth({ db, audit, emit }) {
  const failures = new Map(); // username -> { count, until }

  const auth = {
    /** Creates the first administrator from ADMIN_PASSWORD when there are no accounts yet. */
    async bootstrap({ username = "admin", password }) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM staff_users");
      if (rows[0].n || !password) return null;
      // A bad ADMIN_PASSWORD mustn't stop the server starting: warn and carry on.
      if (password.length < 8) {
        console.warn("ADMIN_PASSWORD is shorter than 8 characters, so no administrator was created from it. Set a longer one.");
        return null;
      }
      const user = await auth.createUser({ username, name: "Administrator", role: "admin", password }, null);
      console.log(`Created the first administrator account "${user.username}" (password: ADMIN_PASSWORD).`);
      return user;
    },

    /**
     * Makes sure a fixed sign-in exists (created once, never reset), e.g. the
     * shared "Test" administrator. Its password isn't held to the length rule.
     */
    async ensureAccount({ username, name, password, role = "admin" }) {
      const key = String(username).trim().toLowerCase();
      const { rows } = await db.query("SELECT 1 FROM staff_users WHERE username = $1", [key]);
      if (rows.length) return null;
      const id = `u_${crypto.randomBytes(6).toString("hex")}`;
      const created = await db.query(
        "INSERT INTO staff_users (id, username, name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [id, key, name, role, await hashPassword(password)],
      );
      await audit(null, "staff.create", "staff_user", id, { username: key, role });
      return publicUser(created.rows[0]);
    },

    async login(username, password) {
      const key = String(username ?? "").trim().toLowerCase();
      const f = failures.get(key);
      if (f && f.count >= 8 && f.until > Date.now()) {
        throw new HttpError(429, "Too many failed sign-ins. Try again in 15 minutes.");
      }
      const { rows } = await db.query("SELECT * FROM staff_users WHERE username = $1", [key]);
      const user = rows[0];
      const ok = user?.active && (await verifyPassword(password, user.password_hash));
      if (!ok) {
        const next = { count: (f?.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 };
        failures.set(key, next);
        throw new HttpError(401, "Wrong username or password");
      }
      failures.delete(key);
      const token = crypto.randomBytes(32).toString("hex");
      await db.query(
        "INSERT INTO staff_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))",
        [sha256(token), user.id, SESSION_DAYS],
      );
      await db.query("DELETE FROM staff_sessions WHERE expires_at < now()");
      await audit(publicUser(user), "auth.login", "staff_user", user.id, {});
      return { token, user: publicUser(user) };
    },

    async logout(token) {
      await db.query("DELETE FROM staff_sessions WHERE token_hash = $1", [sha256(token)]);
    },

    async userForToken(token) {
      if (!token) return null;
      const { rows } = await db.query(
        `SELECT u.* FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
        [sha256(token)],
      );
      return rows[0] ? publicUser(rows[0]) : null;
    },

    async listUsers() {
      const { rows } = await db.query("SELECT * FROM staff_users ORDER BY active DESC, name");
      return rows.map(publicUser);
    },

    async createUser(input, actor) {
      const fields = checkUserFields(input ?? {}, { creating: true });
      checkPassword(input.password);
      const taken = await db.query("SELECT 1 FROM staff_users WHERE username = $1", [fields.username]);
      if (taken.rows.length) throw new HttpError(409, "That username is taken.");
      const id = `u_${crypto.randomBytes(6).toString("hex")}`;
      const { rows } = await db.query(
        `INSERT INTO staff_users (id, username, name, email, role, permissions, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, fields.username, fields.name, fields.email ?? "", fields.role, fields.permissions ?? [], await hashPassword(input.password)],
      );
      const user = publicUser(rows[0]);
      await audit(actor, "staff.create", "staff_user", id, { username: user.username, role: user.role, permissions: user.extraPermissions });
      await emit({ type: "staff", id });
      return user;
    },

    async updateUser(id, input, actor) {
      const fields = checkUserFields(input ?? {}, { creating: false });
      delete fields.username;
      const { rows: found } = await db.query("SELECT * FROM staff_users WHERE id = $1", [id]);
      if (!found.length) throw new HttpError(404, "Employee not found");
      const before = found[0];
      // Never lock everyone out of staff management.
      const demoting = (fields.role && fields.role !== "admin") || fields.active === false;
      if (before.role === "admin" && before.active && demoting) {
        const admins = await db.query("SELECT count(*)::int AS n FROM staff_users WHERE role = 'admin' AND active AND id <> $1", [id]);
        if (!admins.rows[0].n) throw new HttpError(400, "There must be at least one active administrator.");
      }
      const sets = [];
      const params = [id];
      for (const [k, v] of Object.entries(fields)) {
        params.push(v);
        sets.push(`${k} = $${params.length}`);
      }
      if (input.password) {
        checkPassword(input.password);
        params.push(await hashPassword(input.password));
        sets.push(`password_hash = $${params.length}`);
      }
      if (!sets.length) return publicUser(before);
      const { rows } = await db.query(`UPDATE staff_users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      if (fields.active === false || input.password) await db.query("DELETE FROM staff_sessions WHERE user_id = $1", [id]);
      const user = publicUser(rows[0]);
      await audit(actor, "staff.update", "staff_user", id, {
        changes: { ...fields, ...(input.password && { password: "changed" }) },
      });
      await emit({ type: "staff", id });
      return user;
    },
  };
  return auth;
}
