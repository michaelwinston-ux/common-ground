/* eslint-disable no-undef */
/**
 * Common Ground -- infinite deterministic patchwork.
 *
 * World units == native source-image pixels. Each integer cell (i, j) occupies
 * world rect (i*T, j*T, T, T) where T = manifest.tileSize (the smallest
 * min-dimension across every source image).
 *
 * Camera (camX, camY) is the world coordinate at the center of the viewport.
 * `zoom` is screen pixels per world pixel:
 *   zoom = 1.0  -> 1 source pixel maps to 1 screen pixel (true 1:1).
 *   zoom = 0.025 -> 40x zoomed out (one source pixel covers 0.025 screen px).
 *
 * For every visible cell we deterministically pick (imageIdx, cropX, cropY)
 * from a 32-bit hash of (i, j, seed). The chosen sub-image is drawn from the
 * best loaded resolution tier (thumb / medium / full); higher tiers are queued
 * lazily and the full-res cache is bounded by an LRU policy.
 */

// ----- Manifest / images -----
let manifest = null;
let images = [];
let tileSize = 0;
let manifestLoaded = false;
let imageBuckets = [];

// ----- Determinism -----
let seed = 1337;

// ----- Camera -----
let camX = 0;
let camY = 0;
let zoom = 0.025;
const MIN_ZOOM = 0.025;
const MAX_ZOOM = 1.0;
const ZOOM_PER_FRAME = 1.02;
const PAN_SPEED_DIVISOR = 32;
const AUTO_CAMERA = true;
const START_TILE_ZOOM = 1.0;
const MID_ARC_ZOOM = 0.022;
const TARGET_TILE_ZOOM = 1.0;
const ARC_DURATION_FRAMES = 1620;
const MAX_TARGET_TILE_DISTANCE = 8;
const HORIZONTAL_MOVE_START_T = 0.232;
const HORIZONTAL_MOVE_END_T = 0.785;
const ZOOM_IN_SOFT_START_POWER = 2.0;

let autoCameraReady = false;
let currentTileI = 0;
let currentTileJ = 0;
let moveStartX = 0;
let moveStartY = 0;
let moveEndX = 0;
let moveEndY = 0;
let moveFrame = 0;
let moveDuration = ARC_DURATION_FRAMES;

// ----- Image cache -----
const thumbs = [];
const mediums = new Map();
const fulls = new Map();
const loading = new Set();
const loadQueue = [];
const MAX_CONCURRENT_LOADS = 4;
const FULL_LRU_CAP = 24;
const MEDIUM_CAP = 80;

// ----- HUD -----
let lastFpsSample = 0;
let fpsValue = 0;
const NEARBY_SOURCE_RADIUS = 2;

// ----- p5 lifecycle -----
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  imageMode(CORNER);
  noSmooth();
  textFont("ui-monospace, Menlo, monospace");

  fetch("assets/manifest.json")
    .then((r) => {
      if (!r.ok) throw new Error(`manifest http ${r.status}`);
      return r.json();
    })
    .then(initFromManifest)
    .catch((err) => {
      console.error("manifest load failed", err);
      const el = document.getElementById("loading");
      if (el) el.textContent = "manifest load failed -- run `npm run preprocess`";
    });
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function initFromManifest(m) {
  manifest = m;
  images = m.images || [];
  tileSize = m.tileSize | 0;
  seed = ((m.seed ?? 1337) | 0) >>> 0;

  if (!images.length || !tileSize) {
    console.error("manifest missing images or tileSize", m);
    return;
  }

  buildImageBuckets();

  thumbs.length = images.length;
  let remaining = images.length;
  const onDone = () => {
    if (--remaining > 0) return;
    manifestLoaded = true;
    const el = document.getElementById("loading");
    if (el) el.remove();
  };
  images.forEach((meta, idx) => {
    loadImage(
      meta.thumb,
      (img) => {
        thumbs[idx] = img;
        onDone();
      },
      (err) => {
        console.warn("thumb failed", meta.thumb, err);
        onDone();
      }
    );
  });

  if (AUTO_CAMERA) initAutoCamera();
}

function posMod(n, m) {
  return ((n % m) + m) % m;
}

function buildImageBuckets() {
  const classCount = (NEARBY_SOURCE_RADIUS + 1) * (NEARBY_SOURCE_RADIUS + 1);
  imageBuckets = Array.from({ length: classCount }, () => []);
  for (let idx = 0; idx < images.length; idx++) {
    imageBuckets[idx % classCount].push(idx);
  }
}

// ----- Input -----
function applyHeldKeys() {
  if (AUTO_CAMERA) return;
  const panSpeed = tileSize / PAN_SPEED_DIVISOR;
  if (keyIsDown(LEFT_ARROW)) camX -= panSpeed;
  if (keyIsDown(RIGHT_ARROW)) camX += panSpeed;
  if (keyIsDown(UP_ARROW)) camY -= panSpeed;
  if (keyIsDown(DOWN_ARROW)) camY += panSpeed;
  if (keyIsDown(81 /* q */)) zoom = Math.min(MAX_ZOOM, zoom * ZOOM_PER_FRAME);
  if (keyIsDown(65 /* a */)) zoom = Math.max(MIN_ZOOM, zoom / ZOOM_PER_FRAME);
}

function keyPressed() {
  if (AUTO_CAMERA) return;
  if (key === "f" || key === "F") {
    fullscreen(!fullscreen());
  } else if (key === "r" || key === "R") {
    seed = (Math.random() * 0xffffffff) >>> 0;
  } else if (key === "0") {
    camX = 0;
    camY = 0;
    zoom = MIN_ZOOM;
  }
}

function easeInOutCubic(t) {
  if (t < 0.5) return 4 * t * t * t;
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function tileCenter(i, j) {
  return {
    x: i * tileSize + tileSize * 0.5,
    y: j * tileSize + tileSize * 0.5,
  };
}

function initAutoCamera() {
  currentTileI = 0;
  currentTileJ = 0;
  const c = tileCenter(currentTileI, currentTileJ);
  camX = c.x;
  camY = c.y;
  zoom = START_TILE_ZOOM;
  autoCameraReady = true;
  startNextArc();
}

function pickTargetTile() {
  let di = 0;
  let dj = 0;
  while (di === 0 && dj === 0) {
    di = Math.floor(random(-MAX_TARGET_TILE_DISTANCE, MAX_TARGET_TILE_DISTANCE + 1));
    dj = Math.floor(random(-MAX_TARGET_TILE_DISTANCE, MAX_TARGET_TILE_DISTANCE + 1));
    if (Math.max(Math.abs(di), Math.abs(dj)) > MAX_TARGET_TILE_DISTANCE) {
      di = 0;
      dj = 0;
    }
  }
  return {
    i: currentTileI + di,
    j: currentTileJ + dj,
  };
}

function startNextArc() {
  const target = pickTargetTile();
  const start = tileCenter(currentTileI, currentTileJ);
  const end = tileCenter(target.i, target.j);

  moveStartX = start.x;
  moveStartY = start.y;
  moveEndX = end.x;
  moveEndY = end.y;
  moveFrame = 0;
  moveDuration = ARC_DURATION_FRAMES;
  currentTileI = target.i;
  currentTileJ = target.j;
}

function updateAutoCamera() {
  if (!AUTO_CAMERA || !autoCameraReady) return;

  const t = constrain(moveFrame / moveDuration, 0, 1);
  if (t < 0.52) {
    const zt = easeInOutCubic(t / 0.52);
    zoom = lerp(START_TILE_ZOOM, MID_ARC_ZOOM, zt);
  } else {
    const zt = easeInOutCubic((t - 0.52) / 0.48);
    const softened = Math.pow(zt, ZOOM_IN_SOFT_START_POWER);
    zoom = lerp(MID_ARC_ZOOM, TARGET_TILE_ZOOM, softened);
  }

  // Horizontal travel only occurs while zoom is in the lower range.
  const horizontalPhase = constrain(
    (t - HORIZONTAL_MOVE_START_T) /
      (HORIZONTAL_MOVE_END_T - HORIZONTAL_MOVE_START_T),
    0,
    1
  );
  const pathProg = easeInOutCubic(horizontalPhase);
  camX = lerp(moveStartX, moveEndX, pathProg);
  camY = lerp(moveStartY, moveEndY, pathProg);

  moveFrame++;
  if (moveFrame > moveDuration) startNextArc();
}

// ----- Deterministic tile lookup -----
function hash32(x, y, s) {
  let h = (s | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function rand01(u32) {
  return (u32 >>> 0) / 4294967296;
}

function tileFor(i, j) {
  const h1 = hash32(i, j, seed);
  const h2 = hash32(i + 17, j - 31, (seed ^ 0xdeadbeef) | 0);
  const h3 = hash32(i - 9, j + 53, (seed ^ 0x12345678) | 0);
  const classSize = NEARBY_SOURCE_RADIUS + 1;
  const classId = posMod(i, classSize) + classSize * posMod(j, classSize);
  const bucket = imageBuckets[classId];
  const imageIdx = (bucket && bucket.length ? bucket[h1 % bucket.length] : h1 % images.length);
  const meta = images[imageIdx];
  const cropX = Math.floor(rand01(h2) * (meta.width - tileSize + 1));
  const cropY = Math.floor(rand01(h3) * (meta.height - tileSize + 1));
  return { imageIdx, cropX, cropY };
}

// ----- Lazy loader -----
function enqueue(tier, idx) {
  const key = `${tier}:${idx}`;
  if (loading.has(key)) return;
  for (let k = 0; k < loadQueue.length; k++) {
    if (loadQueue[k].tier === tier && loadQueue[k].idx === idx) return;
  }
  loadQueue.push({ tier, idx });
}

function pumpLoads() {
  while (loading.size < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
    const { tier, idx } = loadQueue.shift();
    const key = `${tier}:${idx}`;
    if (loading.has(key)) continue;
    if (tier === "full" && fulls.has(idx)) continue;
    if (tier === "medium" && mediums.has(idx)) continue;

    const meta = images[idx];
    const url = tier === "full" ? meta.file : meta.medium;
    loading.add(key);
    loadImage(
      url,
      (img) => {
        loading.delete(key);
        if (tier === "full") fulls.set(idx, { img, lastUsed: frameCount });
        else mediums.set(idx, img);
      },
      (err) => {
        loading.delete(key);
        console.warn("load failed", url, err);
      }
    );
  }
}

function evictCaches() {
  if (fulls.size > FULL_LRU_CAP) {
    const entries = [...fulls.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed
    );
    while (fulls.size > FULL_LRU_CAP) {
      const [k] = entries.shift();
      fulls.delete(k);
    }
  }
  if (mediums.size > MEDIUM_CAP) {
    // Mediums are cheap; just trim oldest insertion order.
    const keys = [...mediums.keys()];
    while (mediums.size > MEDIUM_CAP) {
      mediums.delete(keys.shift());
    }
  }
}

function selectTier(tileScreenPx, idx) {
  let desired;
  if (tileScreenPx >= tileSize * 0.5) desired = "full";
  else if (tileScreenPx >= 256) desired = "medium";
  else desired = "thumb";

  if (desired === "full") {
    const f = fulls.get(idx);
    if (f) {
      f.lastUsed = frameCount;
      return { tier: "full", img: f.img };
    }
    enqueue("full", idx);
    const m = mediums.get(idx);
    if (m) return { tier: "medium", img: m };
    enqueue("medium", idx);
    return { tier: "thumb", img: thumbs[idx] };
  }
  if (desired === "medium") {
    const m = mediums.get(idx);
    if (m) return { tier: "medium", img: m };
    enqueue("medium", idx);
    return { tier: "thumb", img: thumbs[idx] };
  }
  return { tier: "thumb", img: thumbs[idx] };
}

// ----- Draw a single tile -----
function drawTile(i, j) {
  const { imageIdx, cropX, cropY } = tileFor(i, j);
  const meta = images[imageIdx];

  const screenX = (i * tileSize - camX) * zoom + width / 2;
  const screenY = (j * tileSize - camY) * zoom + height / 2;
  const screenSize = tileSize * zoom;

  if (
    screenX + screenSize < 0 ||
    screenY + screenSize < 0 ||
    screenX > width ||
    screenY > height
  )
    return;

  const sel = selectTier(screenSize, imageIdx);
  const src = sel.img;
  if (!src || !src.width) return;

  // Scale the native-resolution crop into the loaded tier's pixel space.
  const sxScale = src.width / meta.width;
  const syScale = src.height / meta.height;
  const sx = cropX * sxScale;
  const sy = cropY * syScale;
  const sw = tileSize * sxScale;
  const sh = tileSize * syScale;
  const rotSteps = 1 + (hash32(i + 101, j - 47, (seed ^ 0x7f4a7c15) | 0) % 3);
  const centerX = screenX + screenSize * 0.5;
  const centerY = screenY + screenSize * 0.5;

  push();
  translate(centerX, centerY);
  rotate(rotSteps * HALF_PI);
  imageMode(CENTER);
  image(src, 0, 0, screenSize, screenSize, sx, sy, sw, sh);
  pop();
}

// ----- Main loop -----
function draw() {
  background(0);
  if (!manifestLoaded) return;

  applyHeldKeys();
  updateAutoCamera();

  const halfW = width / (2 * zoom);
  const halfH = height / (2 * zoom);
  const iMin = Math.floor((camX - halfW) / tileSize) - 1;
  const iMax = Math.floor((camX + halfW) / tileSize) + 1;
  const jMin = Math.floor((camY - halfH) / tileSize) - 1;
  const jMax = Math.floor((camY + halfH) / tileSize) + 1;

  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) drawTile(i, j);
  }

  pumpLoads();
  evictCaches();
  drawHud();
}

// ----- HUD -----
function drawHud() {
  if (frameCount - lastFpsSample > 15) {
    fpsValue = frameRate();
    lastFpsSample = frameCount;
  }
  const targetInfo = tileFor(currentTileI, currentTileJ);
  const targetMeta = images[targetInfo.imageIdx];
  const targetFile = targetMeta?.file ? targetMeta.file.split("/").pop() : "n/a";
  const lines = [
    `seed   ${seed >>> 0}`,
    `zoom   ${zoom.toFixed(3)}    (1.000 = native 1:1)`,
    `cam    ${camX | 0}, ${camY | 0}`,
    `tile   ${tileSize}px world`,
    `target ${currentTileI}, ${currentTileJ}   ${targetFile}`,
    `fps    ${fpsValue.toFixed(0)}`,
    `cache  full ${fulls.size}/${FULL_LRU_CAP}   med ${mediums.size}   loading ${loading.size}`,
    AUTO_CAMERA
      ? `cam    auto arc pan + eased zoom`
      : `keys   arrows pan   q/a zoom   f fullscreen   r reseed   0 reset`,
  ];
  push();
  noStroke();
  fill(0, 170);
  rect(8, 8, 420, lines.length * 16 + 12);
  fill(235);
  textAlign(LEFT, TOP);
  textSize(11);
  for (let k = 0; k < lines.length; k++) text(lines[k], 16, 14 + k * 16);
  pop();
}
