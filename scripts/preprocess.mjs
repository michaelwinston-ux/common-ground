#!/usr/bin/env node
/**
 * Preprocess assets for the Common Ground patchwork sketch.
 *
 *   1. Walk assets/ (top level only).
 *   2. Delete HEIC/HEIF files (browsers cannot decode them; PNG versions exist).
 *   3. For every supported image (.jpg/.jpeg/.png), record its native dimensions
 *      and emit two downscaled previews:
 *        - assets/previews/thumb/<name>.jpg   (max side 256, q=80)
 *        - assets/previews/medium/<name>.jpg (max side 1024, q=85)
 *   4. Compute tileSize = min over all images of min(width, height) -- the
 *      square tile size in source-image pixels.
 *   5. Write assets/manifest.json with tileSize, seed default and per-image entries.
 *
 * Idempotent: previews are skipped when they are newer than their source.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "assets");
const PREVIEWS_DIR = path.join(ASSETS_DIR, "previews");
const THUMB_DIR = path.join(PREVIEWS_DIR, "thumb");
const MEDIUM_DIR = path.join(PREVIEWS_DIR, "medium");
const MANIFEST_PATH = path.join(ASSETS_DIR, "manifest.json");

const THUMB_MAX = 256;
const MEDIUM_MAX = 1024;

const SUPPORTED = new Set([".jpg", ".jpeg", ".png"]);
const HEIC = new Set([".heic", ".heif"]);

const toPosix = (p) => p.split(path.sep).join("/");
const rel = (p) => toPosix(path.relative(ROOT, p));

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function mtimeMs(p) {
  try {
    const s = await fs.stat(p);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function main() {
  await ensureDir(THUMB_DIR);
  await ensureDir(MEDIUM_DIR);

  const entries = await fs.readdir(ASSETS_DIR, { withFileTypes: true });

  // 1. Delete HEIC/HEIF files.
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (HEIC.has(ext)) {
      await fs.unlink(path.join(ASSETS_DIR, e.name));
      removed++;
    }
  }
  if (removed) console.log(`Removed ${removed} HEIC/HEIF file(s).`);

  // 2. Collect supported image files (re-read after deletions).
  const files = (await fs.readdir(ASSETS_DIR, { withFileTypes: true }))
    .filter((e) => e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No supported images found in ${ASSETS_DIR}.`);
  }

  console.log(`Processing ${files.length} image(s)...`);

  const images = [];
  let minDim = Infinity;
  let processed = 0;
  let skipped = 0;
  let removedAsHeif = 0;
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const srcPath = path.join(ASSETS_DIR, name);
    const baseNoExt = path.basename(name, path.extname(name));
    const thumbPath = path.join(THUMB_DIR, `${baseNoExt}.jpg`);
    const mediumPath = path.join(MEDIUM_DIR, `${baseNoExt}.jpg`);

    let meta;
    try {
      meta = await sharp(srcPath).metadata();
    } catch (err) {
      console.warn(`  ! skipping ${name}: ${err.message}`);
      failed.push(name);
      continue;
    }

    // Some files use a non-HEIC extension (e.g. .Jpg) but contain HEIF data,
    // which neither sharp's libvips build nor browsers can decode. Treat them
    // the same as the explicit HEIC assets we already removed.
    if (meta.format === "heif" || meta.format === "heic" || meta.format === "avif") {
      await fs.unlink(srcPath);
      removedAsHeif++;
      continue;
    }

    if (!meta.width || !meta.height) {
      console.warn(`  ! skipping ${name}: missing dimensions`);
      failed.push(name);
      continue;
    }

    const srcMtime = await mtimeMs(srcPath);
    const needThumb = (await mtimeMs(thumbPath)) < srcMtime;
    const needMedium = (await mtimeMs(mediumPath)) < srcMtime;

    try {
      if (needThumb) {
        await sharp(srcPath)
          .rotate()
          .resize({ width: THUMB_MAX, height: THUMB_MAX, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true })
          .toFile(thumbPath);
      }
      if (needMedium) {
        await sharp(srcPath)
          .rotate()
          .resize({ width: MEDIUM_MAX, height: MEDIUM_MAX, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toFile(mediumPath);
      }
    } catch (err) {
      console.warn(`  ! skipping ${name}: preview generation failed (${err.message})`);
      failed.push(name);
      continue;
    }
    if (needThumb || needMedium) processed++;
    else skipped++;

    // Use post-rotation orientation for the canonical width/height so that
    // crops in the sketch line up with the visible orientation of the image.
    let { width, height } = meta;
    if (meta.orientation && meta.orientation >= 5 && meta.orientation <= 8) {
      [width, height] = [height, width];
    }

    if (Math.min(width, height) < minDim) minDim = Math.min(width, height);

    images.push({
      id: images.length,
      file: rel(srcPath),
      width,
      height,
      thumb: rel(thumbPath),
      medium: rel(mediumPath),
    });

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  ${i + 1}/${files.length}\r`);
    }
  }

  if (removedAsHeif) {
    console.log(`Removed ${removedAsHeif} HEIF-disguised file(s) (wrong extension).`);
  }
  if (failed.length) {
    console.warn(`Failed/skipped: ${failed.length} -> ${failed.join(", ")}`);
  }

  if (!images.length) throw new Error("No images survived metadata reads.");

  const tileSize = minDim;
  const manifest = {
    tileSize,
    seed: 1337,
    generatedAt: new Date().toISOString(),
    images,
  };

  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `\nDone. ${processed} preview pair(s) generated, ${skipped} up-to-date.\n` +
      `tileSize = ${tileSize}px (smallest min-dimension across ${images.length} image(s)).\n` +
      `Manifest: ${rel(MANIFEST_PATH)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
