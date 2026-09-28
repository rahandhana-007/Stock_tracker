// Server uji lokal: meniru Supabase (REST via PostgREST + Auth tiruan) untuk menguji UI tanpa akun Supabase.
// TIDAK dipakai di produksi. Butuh: PostgreSQL lokal (db "fc" sudah diisi schema.sql + seed.sql) dan biner PostgREST.
//
//   POSTGREST_BIN=/tmp/postgrest DB_URI=postgres://authenticator:secret@localhost/fc node tests/local-server.mjs
//
// Lalu buka http://localhost:8080 — login: username demo / password demo1234
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(root, "web");
const PORT = Number(process.env.PORT || 8080);
const PGRST_PORT = Number(process.env.PGRST_PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "local-test-jwt-secret-with-at-least-32-chars!!";
const USERS = { "demo@forecast.local": "demo1234", "anggit@forecast.local": "anggit1234", "admin@forecast.local": "admin1234", "demo@local": "demo1234" };

// ---------------------------------------------------------------- start PostgREST
const pgrstConf = `db-uri = "${process.env.DB_URI || "postgres://authenticator:secret@localhost/fc"}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET}"
server-port = ${PGRST_PORT}
server-host = "127.0.0.1"
db-max-rows = 1000
`;
writeFileSync("/tmp/pgrst.conf", pgrstConf);
const pgrst = spawn(process.env.POSTGREST_BIN || "postgrest", ["/tmp/pgrst.conf"], { stdio: ["ignore", "inherit", "inherit"] });
process.on("exit", () => pgrst.kill());
process.on("SIGTERM", () => { pgrst.kill(); process.exit(0); });
process.on("SIGINT", () => { pgrst.kill(); process.exit(0); });

// ---------------------------------------------------------------- fake GoTrue
const b64 = (s) => Buffer.from(typeof s === "string" ? s : JSON.stringify(s)).toString("base64url");
function jwt(email) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: "authenticated", exp: now + 3600, iat: now, iss: `http://localhost:${PORT}/auth/v1`, sub: userId(email), email, role: "authenticated", session_id: randomUUID() };
  const head = b64({ alg: "HS256", typ: "JWT" }), body = b64(payload);
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return { token: `${head}.${body}.${sig}`, payload };
}
const ids = new Map();
const userId = (email) => { if (!ids.has(email)) ids.set(email, randomUUID()); return ids.get(email); };
const userObj = (email) => ({ id: userId(email), aud: "authenticated", role: "authenticated", email, email_confirmed_at: new Date().toISOString(), app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const refreshTokens = new Map();
function sessionFor(email) {
  const { token, payload } = jwt(email);
  const refresh = randomUUID();
  refreshTokens.set(refresh, email);
  return { access_token: token, token_type: "bearer", expires_in: 3600, expires_at: payload.exp, refresh_token: refresh, user: userObj(email) };
}
function readBody(req) { return new Promise((res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => res(d)); }); }
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); }
function bearerEmail(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ""); if (!m) return null;
  try { const p = JSON.parse(Buffer.from(m[1].split(".")[1], "base64url").toString()); return p.exp > Date.now() / 1000 ? p.email : null; } catch { return null; }
}
async function auth(req, res, url) {
  const path = url.pathname.replace(/^\/auth\/v1/, "");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); return res.end(); }
  if (path === "/token" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      if (USERS[body.email] && USERS[body.email] === body.password) return json(res, 200, sessionFor(body.email));
      return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: 400, msg: "Invalid login credentials", error_code: "invalid_credentials" });
    }
    if (grant === "refresh_token") {
      const email = refreshTokens.get(body.refresh_token);
      if (!email) return json(res, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token", msg: "Invalid Refresh Token", code: 400 });
      refreshTokens.delete(body.refresh_token);
      return json(res, 200, sessionFor(email));
    }
    return json(res, 400, { msg: "unsupported grant", code: 400 });
  }
  if (path === "/user" && req.method === "GET") { const e = bearerEmail(req); return e ? json(res, 200, userObj(e)) : json(res, 401, { msg: "invalid JWT", code: 401 }); }
  if (path === "/user" && req.method === "PUT") { const e = bearerEmail(req); if (!e) return json(res, 401, { msg: "invalid JWT", code: 401 }); const b = JSON.parse((await readBody(req)) || "{}"); if (b.password) USERS[e] = b.password; return json(res, 200, userObj(e)); }
  if (path === "/logout") { res.writeHead(204, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
  if (path === "/recover") return json(res, 200, {});
  json(res, 404, { msg: "not found: " + path, code: 404 });
}

// ---------------------------------------------------------------- proxy + static
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json" };
function proxy(req, res, url) {
  const opts = { host: "127.0.0.1", port: PGRST_PORT, method: req.method, path: url.pathname.replace(/^\/rest\/v1/, "") + url.search, headers: { ...req.headers, host: `127.0.0.1:${PGRST_PORT}` } };
  const up = http.request(opts, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", (e) => json(res, 502, { message: "PostgREST unavailable: " + e.message }));
  req.pipe(up);
}
function serveStatic(req, res, url) {
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p === "/" || p === "\\") p = "/index.html";
  const file = join(WEB, p);
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end("not found"); }
  // Local config: point supabase-js at this same origin (rest + auth proxies).
  if (p === "/config.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(`window.FC_CONFIG = { SUPABASE_URL: location.origin, SUPABASE_ANON_KEY: "local-anon-key", DEFAULT_YEAR: 2026, LOGIN_DOMAIN: "forecast.local", PASSWORD_RESET: false, ADMIN_USERS: ["anggit", "admin"], COMPANY: "PT BRIDGESTONE SUMATRA RUBBER ESTATE", TITLE: "MASTER FORECAST CONSUMPTION PLAN – STOCK ITEMS", LOCAL_DEMO: true };\n`);
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/auth/v1/")) return auth(req, res, url).catch((e) => json(res, 500, { msg: e.message }));
  if (url.pathname.startsWith("/rest/v1/")) return proxy(req, res, url);
  serveStatic(req, res, url);
}).listen(PORT, "0.0.0.0", () => console.log(`[local-server] http://0.0.0.0:${PORT}  (PostgREST :${PGRST_PORT})  login: demo / demo1234`));
