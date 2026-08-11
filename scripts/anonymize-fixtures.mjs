#!/usr/bin/env node
/**
 * Anonymise test fixtures before they go into a public repo.
 *
 * Fixtures are real pages, so they carry other people's usernames, numeric user ids,
 * avatars and review prose — third parties who never agreed to appear in this
 * repository. The parsers only care about structure, so every one of those can be
 * replaced with a synthetic stand-in without weakening a single test.
 *
 * The account owner's own username is left intact: this is their library, published by
 * them, and several tests assert against it.
 *
 * Usage: node scripts/anonymize-fixtures.mjs [ownerUsername]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OWNER = process.argv[2] ?? "Denision";
const DIR = join(import.meta.dirname, "..", "test", "fixtures");

const userMap = new Map();
const idMap = new Map();

function fakeUser(name) {
  if (name === OWNER) return name;
  if (!userMap.has(name)) userMap.set(name, `testuser${userMap.size + 1}`);
  return userMap.get(name);
}

function fakeId(id) {
  if (!idMap.has(id)) idMap.set(id, String(900001 + idMap.size));
  return idMap.get(id);
}

let changed = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
  const path = join(DIR, file);
  let html = readFileSync(path, "utf8");
  const before = html;

  // Usernames in /u/… links, and the display text that follows them.
  html = html.replace(/\/u\/([A-Za-z0-9_-]+)/g, (_m, name) => `/u/${fakeUser(name)}`);
  for (const [real, fake] of userMap) {
    if (real === OWNER) continue;
    html = html.replaceAll(`>${real}<`, `>${fake}<`);
    html = html.replaceAll(`username="${real}"`, `username="${fake}"`);
    html = html.replaceAll(`alt="${real}"`, `alt="${fake}"`);
  }

  // Numeric user ids — the follow buttons expose them directly.
  html = html.replace(/user_id="(\d+)"/g, (_m, id) => `user_id="${fakeId(id)}"`);
  html = html.replace(/friend_btn_(\d+)/g, (_m, id) => `friend_btn_${fakeId(id)}`);

  // Avatar URLs identify accounts even without a name.
  html = html.replace(
    /https:\/\/backloggd-(?:avatars|s3)\.b-cdn\.net\/[^"'\s]+/g,
    "https://example.invalid/avatar.png",
  );

  // Personal share links.
  html = html.replace(/https:\/\/bckl\.gg\/[A-Za-z0-9]+/g, "https://bckl.gg/EXAMPLE");

  // Other people's review prose: keep enough for the parser, drop the rest.
  html = html.replace(
    /(<div class="[^"]*(?:review-body|card-text|review-content)[^"]*"[^>]*>)([\s\S]{0,4000}?)(<\/div>)/g,
    (_m, open, body, close) =>
      body.trim().length > 0 ? `${open}Review text removed for privacy.${close}` : _m,
  );

  if (html !== before) {
    writeFileSync(path, html);
    changed += 1;
  }
}

console.log(`anonymised ${changed} fixture(s)`);
console.log(`  usernames replaced: ${userMap.size}`);
console.log(`  user ids replaced:  ${idMap.size}`);
