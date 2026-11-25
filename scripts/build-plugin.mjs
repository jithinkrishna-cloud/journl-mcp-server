// Builds the ChatGPT plugin ZIP for the OpenAI plugin portal (Agent Plugins format):
//   dist/plugin/{plugin.json, mcp.json, assets/logo.png, assets/icon.png, skills/<name>/...}
//   dist/journl-plugin-<version>.zip
//
// Values come from plugin/plugin.env (see plugin/plugin.env.example) or the environment.
// The build fails on anything the portal would reject: placeholders, non-HTTPS or
// temporary URLs, over-long listing text, or the wrong number of review test cases.
//
//   npm run build:plugin

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];

const vars = {
  VERSION: process.env.PLUGIN_VERSION || pkg.version,
  DEVELOPER_NAME: process.env.DEVELOPER_NAME || "Bizpole",
  CATEGORY: process.env.CATEGORY || "Finance",
  RELEASE_NOTES: process.env.RELEASE_NOTES || "Initial release: read-only JournL accounting reports in ChatGPT.",
  MCP_URL: process.env.MCP_URL,
  WEBSITE_URL: process.env.WEBSITE_URL,
  SUPPORT_URL: process.env.SUPPORT_URL,
  PRIVACY_URL: process.env.PRIVACY_URL,
  TERMS_URL: process.env.TERMS_URL,
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL,
  DEMO_VIDEO_URL: process.env.DEMO_VIDEO_URL,
};

for (const [k, v] of Object.entries(vars)) if (!v) errors.push(`${k} is not set (plugin/plugin.env)`);
for (const k of ["MCP_URL", "WEBSITE_URL", "SUPPORT_URL", "PRIVACY_URL", "TERMS_URL", "DEMO_VIDEO_URL"]) {
  const v = vars[k];
  if (!v) continue;
  let u;
  try { u = new URL(v); } catch { errors.push(`${k} is not a URL: ${v}`); continue; }
  if (u.protocol !== "https:") errors.push(`${k} must use https`);
  if (u.username || u.password) errors.push(`${k} must not embed credentials`);
}
if (vars.MCP_URL) {
  const u = new URL(vars.MCP_URL);
  if (!u.pathname.endsWith("/mcp")) errors.push("MCP_URL should end with /mcp");
  if (/ngrok|localhost|127\.0\.0\.1|trycloudflare/.test(u.hostname)) errors.push("MCP_URL must be the stable production domain, not a tunnel or localhost");
}
if (vars.SUPPORT_EMAIL && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(vars.SUPPORT_EMAIL)) errors.push("SUPPORT_EMAIL is not an email address");
if (!/^\d+\.\d+\.\d+$/.test(vars.VERSION)) errors.push(`version must be semantic (x.y.z), got ${vars.VERSION}`);

const fill = (file) => {
  let text = readFileSync(join(root, "plugin", file), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, String(v ?? "").replace(/"/g, '\\"'));
  const left = text.match(/\{\{[A-Z_]+\}\}/g);
  if (left) errors.push(`${file}: unfilled ${[...new Set(left)].join(", ")}`);
  return JSON.parse(text);
};

const plugin = fill("plugin.template.json");
const mcp = fill("mcp.template.json");

// Portal submission limits (see "Manifest fields" in the submission guide).
const ui = plugin.extensions["com.openai"].interface;
const review = plugin.extensions["com.openai"].review;
const limit = (label, value, max) => value && value.length > max && errors.push(`${label} is ${value.length} chars (max ${max})`);
limit("name", plugin.name, 64);
limit("displayName", ui.displayName, 30);
limit("shortDescription", ui.shortDescription, 30);
limit("longDescription", ui.longDescription, 4000);
limit("developerName", ui.developerName, 80);
if (ui.capabilities.length > 20) errors.push("at most 20 capabilities");
ui.capabilities.forEach((c, i) => limit(`capabilities[${i}]`, c, 120));
if (ui.defaultPrompt.length > 3) errors.push("at most 3 starter prompts");
ui.defaultPrompt.forEach((p, i) => { limit(`defaultPrompt[${i}]`, p, 128); if (p.includes("@")) errors.push(`defaultPrompt[${i}] must not @mention`); });
if (review.test_cases.positive.length !== 5) errors.push("exactly 5 positive test cases are required");
if (review.test_cases.negative.length !== 3) errors.push("exactly 3 negative test cases are required");
review.test_cases.positive.forEach((c, i) => {
  if (!c.tools_triggered || !c.expected_behavior) errors.push(`positive[${i}] needs tools_triggered and expected_behavior`);
});
if (Object.keys(mcp.mcpServers).length !== 1) errors.push("exactly one MCP server is required for plugin-level test cases");

// Icon: square PNG, at least 48x48, at most 4096, under 5 MiB.
const iconSrc = join(root, "assets", "journl-icon.png");
const icon = readFileSync(iconSrc);
const w = icon.readUInt32BE(16), h = icon.readUInt32BE(20);
if (icon.toString("ascii", 1, 4) !== "PNG") errors.push("assets/journl-icon.png is not a PNG");
if (w !== h || w < 48 || w > 4096) errors.push(`icon must be square 48..4096 px, got ${w}x${h}`);
if (icon.length > 5 * 1024 * 1024) errors.push("icon is over 5 MiB");

// Skills: plugin/skills/<name>/SKILL.md (+ agents/openai.yaml). Each needs front matter whose
// name matches its folder and a description; placeholders such as {{MCP_URL}} are filled.
const skillsSrc = join(root, "plugin", "skills");
const skillFiles = []; // [relative path, filled text]
const skillNames = existsSync(skillsSrc) ? readdirSync(skillsSrc, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
if (plugin.skills && !skillNames.length) errors.push("plugin.json declares skills but plugin/skills has none");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
for (const name of skillNames) {
  const dir = join(skillsSrc, name);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push(`skill folder "${name}" must be lowercase-hyphenated, max 64 chars`);
  if (!existsSync(join(dir, "SKILL.md"))) { errors.push(`skills/${name}/SKILL.md is missing`); continue; }
  for (const file of walk(dir)) {
    const rel = relative(skillsSrc, file).split(sep).join("/");
    let text = readFileSync(file, "utf8");
    for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, String(v ?? ""));
    const left = text.match(/\{\{[A-Z_]+\}\}/g);
    if (left) errors.push(`skills/${rel}: unfilled ${[...new Set(left)].join(", ")}`);
    if (rel === `${name}/SKILL.md`) {
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const field = (f) => fm?.[1].match(new RegExp(`^${f}:\\s*(.+)$`, "m"))?.[1].trim();
      if (!fm) errors.push(`skills/${rel}: missing front matter`);
      else {
        if (field("name") !== name) errors.push(`skills/${rel}: name must be "${name}"`);
        const desc = field("description");
        if (!desc) errors.push(`skills/${rel}: description is required`);
        else limit(`skills/${rel} description`, desc, 1024);
      }
    }
    skillFiles.push([rel, text]);
  }
}

if (errors.length) {
  console.error("Plugin package NOT built:\n  - " + errors.join("\n  - "));
  process.exit(1);
}

const out = join(root, "dist", "plugin");
rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
writeFileSync(join(out, "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");
writeFileSync(join(out, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
copyFileSync(iconSrc, join(out, "assets", "logo.png"));
copyFileSync(iconSrc, join(out, "assets", "icon.png"));
for (const [rel, text] of skillFiles) {
  const dest = join(out, "skills", ...rel.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
}

// The ZIP contains the plugin root's contents (plugin.json at the top level).
// Windows: the built-in bsdtar writes ZIPs (Git Bash's GNU tar on PATH cannot). Elsewhere: zip.
const zipName = `journl-plugin-${vars.VERSION}.zip`;
const zip = join(root, "dist", zipName);
const entries = ["plugin.json", "mcp.json", "assets", ...(skillFiles.length ? ["skills"] : [])];
if (process.platform === "win32") {
  const bsdtar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(bsdtar, ["-a", "-c", "-f", join("..", zipName), ...entries], { cwd: out });
} else {
  execFileSync("zip", ["-r", "-X", join("..", zipName), ...entries], { cwd: out });
}
console.log(`Built ${zip}\n  MCP server: ${vars.MCP_URL}\n  icon: ${w}x${h}, ${icon.length} bytes`);
