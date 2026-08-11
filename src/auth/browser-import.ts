import { readdirSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AuthError } from "../errors.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Lift a live `_backloggd_session` cookie out of a local browser profile.
 *
 * Firefox stores it in two possible places and we have to check both:
 *
 *  - `cookies.sqlite`, if the user ticked "remember me" and it became persistent;
 *  - `sessionstore-backups/recovery.jsonlz4`, if it is a plain session cookie, which
 *    is the default. That file is mozLz4 — a 12-byte header followed by a raw LZ4
 *    block — so it needs decompressing before the JSON inside can be read.
 */
export async function importSessionFromBrowser(
  browser: "firefox" | "chrome",
): Promise<string> {
  if (browser === "chrome") {
    throw new AuthError(
      "Chrome cookie import is not supported.",
      "Chrome encrypts its cookie store with a key held in the OS keychain, which " +
        "this server deliberately does not touch. Use BACKLOGGD_SESSION with the " +
        "cookie value copied from DevTools, or BACKLOGGD_USERNAME/BACKLOGGD_PASSWORD.",
    );
  }

  const profile = findFirefoxProfile();
  const fromDb = readFromCookiesDb(profile);
  if (fromDb) return fromDb;

  const fromSession = readFromSessionStore(profile);
  if (fromSession) return fromSession;

  throw new AuthError(
    "No Backloggd session cookie found in the Firefox profile.",
    "Log in to backloggd.com in Firefox first. If you are already logged in, the " +
      "session may only exist in memory — reload a Backloggd page, then retry.",
  );
}

function findFirefoxProfile(): string {
  const roots =
    process.platform === "darwin"
      ? [join(homedir(), "Library", "Application Support", "Firefox", "Profiles")]
      : process.platform === "win32"
        ? [join(process.env["APPDATA"] ?? "", "Mozilla", "Firefox", "Profiles")]
        : [join(homedir(), ".mozilla", "firefox")];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));

    // Prefer a profile that actually has Backloggd state over the merely default-named.
    const withState = dirs.find((d) =>
      existsSync(join(d, "sessionstore-backups", "recovery.jsonlz4")),
    );
    const defaultRelease = dirs.find((d) => d.endsWith(".default-release"));
    const chosen = withState ?? defaultRelease ?? dirs[0];
    if (chosen) return chosen;
  }
  throw new AuthError(
    "Could not locate a Firefox profile directory.",
    "Set BACKLOGGD_SESSION manually instead.",
  );
}

function readFromCookiesDb(profile: string): string | null {
  const db = join(profile, "cookies.sqlite");
  if (!existsSync(db)) return null;

  // Copy first: Firefox holds a lock, and we must never write to the user's profile.
  const tmp = join(tmpdir(), `bl-cookies-${process.pid}-${Date.now()}.sqlite`);
  try {
    copyFileSync(db, tmp);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(db + suffix)) copyFileSync(db + suffix, tmp + suffix);
    }
    // node:sqlite is available from Node 22; treat absence as "just use the other path".
    let DatabaseSync: (new (p: string, o?: unknown) => {
      prepare(sql: string): { get(...a: unknown[]): unknown };
      close(): void;
    }) | undefined;
    try {
      ({ DatabaseSync } = nodeRequire("node:sqlite") as {
        DatabaseSync: NonNullable<typeof DatabaseSync>;
      });
    } catch {
      return null;
    }
    if (!DatabaseSync) return null;

    const conn = new DatabaseSync(tmp, { readOnly: true });
    try {
      const row = conn
        .prepare(
          "SELECT value FROM moz_cookies WHERE host LIKE '%backloggd.com' " +
            "AND name = '_backloggd_session' LIMIT 1",
        )
        .get() as { value?: string } | undefined;
      return row?.value ?? null;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(tmp + suffix, { force: true });
    }
  }
}

function readFromSessionStore(profile: string): string | null {
  const candidates = [
    join(profile, "sessionstore-backups", "recovery.jsonlz4"),
    join(profile, "sessionstore-backups", "recovery.baklz4"),
    join(profile, "sessionstore-backups", "previous.jsonlz4"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const json = JSON.parse(decompressMozLz4(readFileSync(path)).toString("utf8")) as {
        cookies?: BrowserCookie[];
        windows?: { cookies?: BrowserCookie[] }[];
      };
      const all = [...(json.cookies ?? []), ...(json.windows ?? []).flatMap((w) => w.cookies ?? [])];
      const hit = all.find(
        (c) => c.host?.includes("backloggd.com") && c.name === "_backloggd_session",
      );
      if (hit?.value) return hit.value;
    } catch {
      continue;
    }
  }
  return null;
}

interface BrowserCookie {
  host?: string;
  name?: string;
  value?: string;
}

/** mozLz4 container: `mozLz40\0` magic, uint32 LE decompressed size, then an LZ4 block. */
function decompressMozLz4(buf: Buffer): Buffer {
  const magic = buf.subarray(0, 8).toString("latin1");
  if (magic !== "mozLz40\0") throw new Error(`unexpected mozLz4 magic: ${magic}`);
  const size = buf.readUInt32LE(8);
  return lz4BlockDecompress(buf.subarray(12), size);
}

/**
 * Minimal LZ4 block decoder. The format is a sequence of sequences: a token byte whose
 * high nibble is the literal length and low nibble the match length, optional extended
 * length bytes (0xFF means "keep reading"), the literals themselves, then a 16-bit
 * little-endian back-offset into the output. Match length is stored minus its 4-byte
 * minimum. Overlapping copies are legal and must be done byte-by-byte.
 */
function lz4BlockDecompress(src: Buffer, expectedSize: number): Buffer {
  const dst = Buffer.allocUnsafe(expectedSize);
  let sIdx = 0;
  let dIdx = 0;

  const readLength = (initial: number): number => {
    let len = initial;
    if (initial === 15) {
      let b: number;
      do {
        b = src[sIdx++] ?? 0;
        len += b;
      } while (b === 255 && sIdx < src.length);
    }
    return len;
  };

  while (sIdx < src.length) {
    const token = src[sIdx++];
    if (token === undefined) break;

    const literalLength = readLength(token >> 4);
    if (literalLength > 0) {
      src.copy(dst, dIdx, sIdx, sIdx + literalLength);
      sIdx += literalLength;
      dIdx += literalLength;
    }
    if (sIdx >= src.length) break;

    const offset = (src[sIdx] ?? 0) | ((src[sIdx + 1] ?? 0) << 8);
    sIdx += 2;
    if (offset === 0) break;

    const matchLength = readLength(token & 0x0f) + 4;
    let from = dIdx - offset;
    for (let i = 0; i < matchLength && dIdx < expectedSize; i++) {
      dst[dIdx++] = dst[from++] ?? 0;
    }
  }
  return dst.subarray(0, dIdx);
}
