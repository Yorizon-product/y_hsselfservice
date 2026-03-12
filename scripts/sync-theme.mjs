#!/usr/bin/env node

/**
 * Sync theme tokens from a tweakcn instance into app/globals.css.
 *
 * Usage:
 *   TWEAKCN_URL=https://... node scripts/sync-theme.mjs
 *   npm run sync-theme
 *
 * The script fetches the CSS export from the tweakcn instance,
 * extracts :root and .dark variable blocks, and merges them
 * into globals.css — preserving all other content (fonts, animations, etc.).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBALS_PATH = resolve(__dirname, "../app/globals.css");

const url = process.env.TWEAKCN_URL;
if (!url) {
  console.log("TWEAKCN_URL not set — skipping theme sync.");
  process.exit(0);
}

async function fetchTheme() {
  console.log(`Fetching theme from ${url}...`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`Error: Could not reach tweakcn instance at ${url}`);
    console.error(err.message);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`Error: tweakcn returned ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const contentType = res.headers.get("content-type") || "";

  // Support both CSS and JSON responses
  if (contentType.includes("application/json")) {
    const json = await res.json();
    // tweakcn registry format: { cssVars: { light: {...}, dark: {...} } }
    if (json.cssVars && (json.cssVars.light || json.cssVars.dark)) {
      return jsonToCSS(json.cssVars);
    }
    // tweakcn JSON export: { css: "..." } (string)
    if (typeof json.css === "string") return json.css;
    // Fallback: { light: {...}, dark: {...} }
    if (json.light || json.dark) return jsonToCSS(json);
    console.error("Error: Unexpected JSON format from tweakcn. Expected { cssVars }, { css } or { light, dark }.");
    process.exit(1);
  }

  return await res.text();
}

function jsonToCSS(json) {
  let css = "";
  if (json.light) {
    css += ":root {\n";
    for (const [key, val] of Object.entries(json.light)) {
      css += `  --${key}: ${val};\n`;
    }
    css += "}\n\n";
  }
  if (json.dark) {
    css += ".dark {\n";
    for (const [key, val] of Object.entries(json.dark)) {
      css += `  --${key}: ${val};\n`;
    }
    css += "}\n";
  }
  return css;
}

/**
 * Extract CSS variable blocks from fetched theme CSS.
 * Returns { light: string, dark: string } with the inner variable declarations.
 */
function extractVarBlocks(css) {
  const result = { light: null, dark: null };

  // Match :root { ... }
  const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
  if (rootMatch) result.light = rootMatch[1].trim();

  // Match .dark { ... }
  const darkMatch = css.match(/\.dark\s*\{([^}]+)\}/);
  if (darkMatch) result.dark = darkMatch[1].trim();

  return result;
}

/**
 * Replace variable blocks in globals.css, preserving everything else.
 */
function mergeIntoGlobals(globals, blocks) {
  let result = globals;

  if (blocks.light) {
    // Replace the :root block inside @layer base
    result = result.replace(
      /(:root\s*\{)[^}]+(})/,
      `$1\n    ${blocks.light.split("\n").join("\n    ")}\n  $2`
    );
  }

  if (blocks.dark) {
    // Replace the .dark block inside @layer base
    result = result.replace(
      /(\.dark\s*\{)[^}]+(})/,
      `$1\n    ${blocks.dark.split("\n").join("\n    ")}\n  $2`
    );

    // Also update the prefers-color-scheme block
    result = result.replace(
      /(:root:not\(\.light\)\s*\{)[^}]+(})/,
      `$1\n      ${blocks.dark.split("\n").join("\n      ")}\n    $2`
    );
  }

  return result;
}

// Main
const themeCss = await fetchTheme();
const blocks = extractVarBlocks(themeCss);

if (!blocks.light && !blocks.dark) {
  console.error("Error: Could not extract any CSS variable blocks from the response.");
  console.error("Expected :root { ... } and/or .dark { ... } blocks.");
  process.exit(1);
}

const globals = readFileSync(GLOBALS_PATH, "utf-8");
const updated = mergeIntoGlobals(globals, blocks);

if (updated === globals) {
  console.log("No changes detected — globals.css is already up to date.");
} else {
  writeFileSync(GLOBALS_PATH, updated);
  console.log("Theme synced successfully into app/globals.css");
  if (blocks.light) console.log("  - Updated :root (light mode) variables");
  if (blocks.dark) console.log("  - Updated .dark + prefers-color-scheme variables");
}
