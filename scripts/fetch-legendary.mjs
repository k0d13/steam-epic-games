// Fetches the legendary binary that ships with this plugin.
//
// The binary is not committed. It is downloaded from an upstream GitHub release
// pinned by tag *and* by SHA-256: the download is rejected unless it hashes to
// exactly the bytes recorded below, so a compromised release, a hijacked CDN or
// a man-in-the-middle cannot slip a different executable into a build.
//
// To upgrade, bump VERSION and replace SHA256 with the `digest` field GitHub
// publishes for the asset:
//
//   curl -sL https://api.github.com/repos/legendary-gl/legendary/releases/latest
//
// legendary is GPL-3.0; see backend/vendor/LICENSE.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.21.0";
const ASSET = "legendary_windows_x64.exe";
const SHA256 = "4c01a14c0acb0c46069b197ae7212ea4ea6b861661126ca0593cdac31658fb01";

const URL = `https://github.com/legendary-gl/legendary/releases/download/${VERSION}/${ASSET}`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "backend", "vendor", "legendary.exe");

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Resolves to the file's hash, or null if it isn't there. */
async function existingDigest() {
  try {
    return digest(await readFile(target));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const current = await existingDigest();

if (current === SHA256) {
  console.log(`legendary ${VERSION} already vendored`);
  process.exit(0);
}

if (current !== null) {
  console.log("Vendored legendary does not match the pin, refetching");
}

console.log(`Fetching legendary ${VERSION} from ${URL}`);

const response = await fetch(URL, { redirect: "follow" });
if (!response.ok) {
  throw new Error(`Download failed: ${response.status} ${response.statusText}`);
}

const binary = Buffer.from(await response.arrayBuffer());
const actual = digest(binary);

if (actual !== SHA256) {
  throw new Error(
    `Checksum mismatch for ${ASSET}\n  expected ${SHA256}\n  actual   ${actual}\n` +
      "Refusing to vendor an unverified executable.",
  );
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, binary, { mode: 0o755 });

console.log(`Vendored legendary ${VERSION} to ${target}`);
