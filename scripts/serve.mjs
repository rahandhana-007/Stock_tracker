// Server statis sederhana untuk mencoba folder web/ secara lokal (tanpa cache).
//   node scripts/serve.mjs            → http://localhost:8080
//   PORT=3000 node scripts/serve.mjs
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(dirname(fileURLToPath(import.meta.url))), "web");
const PORT = Number(process.env.PORT || 8080);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

http.createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  if (p === "/" || p === "\\") p = "/index.html";
  const file = join(WEB, p);
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, "0.0.0.0", () => console.log(`[serve] web/ → http://0.0.0.0:${PORT}`));
