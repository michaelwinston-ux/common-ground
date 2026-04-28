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

// ----- Auto motion (random jump) -----
let randomJumpEnabled = true;
// Discrete snap updates: higher value => slower animation.
const JUMP_EVERY_N_FRAMES = 12; // ~1 jump per 0.2-0.4s depending on FPS
const JUMP_RANGE_TILES = 2; // max +/- tiles to jump per update
const GRID_PHASE_MS = 8000;
const ZOOM_PHASE_MS = 1800;
const FOCUS_PHASE_MS = 6000;

// ----- Single-image focus mode -----
// When enabled, the view is locked to one deterministic frame at a time, but we
// render the entire chosen source image fitted inside the viewport.
let focusSingleTile = true;
let focusI = 0;
let focusJ = 0;

// ----- 10x10 texture mode -----
// Renders a fixed 10x10 tile sheet (useful as a texture). Random jumps change
// which 10x10 region is shown.
let texture10x10Enabled = false;
let texI0 = 0;
let texJ0 = 0;

// ----- Auto cycle -----
let cycleMode = "grid";
let cyclePhaseStartedAt = 0;
let cycleEnabled = true;

// ----- Focus animation -----
let focusImageIdx = 0;
let focusCropX = 0;
let focusCropY = 0;
let zoomCamFromX = 0;
let zoomCamFromY = 0;
let zoomCamFromZoom = MIN_ZOOM;
let zoomCamToX = 0;
let zoomCamToY = 0;
let zoomCamToZoom = MAX_ZOOM;

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

  cyclePhaseStartedAt = millis();
  texture10x10Enabled = true;
  focusSingleTile = false;
  randomJumpEnabled = false;
  cycleEnabled = true;
}

// ----- Input -----
function applyHeldKeys() {
  if (focusSingleTile) return;
  const panSpeed = tileSize / PAN_SPEED_DIVISOR;
  if (keyIsDown(LEFT_ARROW)) camX -= panSpeed;
  if (keyIsDown(RIGHT_ARROW)) camX += panSpeed;
  if (keyIsDown(UP_ARROW)) camY -= panSpeed;
  if (keyIsDown(DOWN_ARROW)) camY += panSpeed;
  if (keyIsDown(81 /* q */)) zoom = Math.min(MAX_ZOOM, zoom * ZOOM_PER_FRAME);
  if (keyIsDown(65 /* a */)) zoom = Math.max(MIN_ZOOM, zoom / ZOOM_PER_FRAME);
}

function keyPressed() {
  if (key === "f" || key === "F") {
    fullscreen(!fullscreen());
  } else if (key === "r" || key === "R") {
    seed = (Math.random() * 0xffffffff) >>> 0;
  } else if (key === "j" || key === "J") {
    randomJumpEnabled = !randomJumpEnabled;
  } else if (key === "g" || key === "G") {
    texture10x10Enabled = !texture10x10Enabled;
  } else if (key === "t" || key === "T") {
    focusSingleTile = !focusSingleTile;
  } else if (key === "c" || key === "C") {
    cycleEnabled = !cycleEnabled;
    cyclePhaseStartedAt = millis();
  } else if (key === "0") {
    camX = 0;
    camY = 0;
    zoom = MIN_ZOOM;
    focusI = 0;
    focusJ = 0;
    texI0 = 0;
    texJ0 = 0;
    cycleMode = "grid";
    cyclePhaseStartedAt = millis();
  }
}

function updateCameraToFocusTile() {
  camX = (focusI + 0.5) * tileSize;
  camY = (focusJ + 0.5) * tileSize;
}

function chooseRandomFocusFromGrid() {
  focusI = texI0 + Math.floor(Math.random() * 10);
  focusJ = texJ0 + Math.floor(Math.random() * 10);
  const { imageIdx, cropX, cropY } = tileFor(focusI, focusJ);
  focusImageIdx = imageIdx;
  focusCropX = cropX;
  focusCropY = cropY;
}

function fitRect(srcWidth, srcHeight, dstWidth, dstHeight) {
  const scale = Math.min(dstWidth / srcWidth, dstHeight / srcHeight);
  const drawW = srcWidth * scale;
  const drawH = srcHeight * scale;
  return {
    x: (dstWidth - drawW) / 2,
    y: (dstHeight - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

function coverRect(srcWidth, srcHeight, dstWidth, dstHeight) {
  const scale = Math.max(dstWidth / srcWidth, dstHeight / srcHeight);
  const drawW = srcWidth * scale;
  const drawH = srcHeight * scale;
  return {
    x: (dstWidth - drawW) / 2,
    y: (dstHeight - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

function getTextureGridLayout() {
  const tiles = 10;
  // Overscan slightly so the 10x10 wall covers the full viewport with no
  // black margins, then crop the excess off-screen.
  const tilePx = Math.ceil(Math.max(width, height) / tiles);
  const gridW = tilePx * tiles;
  const gridH = tilePx * tiles;
  return {
    tiles,
    tilePx,
    gridW,
    gridH,
    x0: Math.floor((width - gridW) / 2),
    y0: Math.floor((height - gridH) / 2),
  };
}

function getGridCameraState() {
  const layout = getTextureGridLayout();
  return {
    x: (texI0 + layout.tiles / 2) * tileSize,
    y: (texJ0 + layout.tiles / 2) * tileSize,
    zoom: layout.tilePx / tileSize,
  };
}

function getFocusCameraState() {
  const targetZoom = Math.min(MAX_ZOOM, (Math.min(width, height) * 0.9) / tileSize);
  return {
    x: (focusI + 0.5) * tileSize,
    y: (focusJ + 0.5) * tileSize,
    zoom: Math.max(MIN_ZOOM, targetZoom),
  };
}

function beginCameraZoom() {
  const from = getGridCameraState();
  const to = getFocusCameraState();
  zoomCamFromX = from.x;
  zoomCamFromY = from.y;
  zoomCamFromZoom = from.zoom;
  zoomCamToX = to.x;
  zoomCamToY = to.y;
  zoomCamToZoom = to.zoom;
}

function beginCameraZoomOut() {
  const from = getFocusCameraState();
  const to = getGridCameraState();
  zoomCamFromX = from.x;
  zoomCamFromY = from.y;
  zoomCamFromZoom = from.zoom;
  zoomCamToX = to.x;
  zoomCamToY = to.y;
  zoomCamToZoom = to.zoom;
}

function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateCycleState() {
  if (!cycleEnabled) return;
  const now = millis();
  const elapsed = now - cyclePhaseStartedAt;

  if (cycleMode === "grid") {
    texture10x10Enabled = true;
    focusSingleTile = false;
    if (elapsed >= GRID_PHASE_MS) {
      chooseRandomFocusFromGrid();
      beginCameraZoom();
      cycleMode = "zoom";
      cyclePhaseStartedAt = now;
    }
    return;
  }

  if (cycleMode === "zoom") {
    texture10x10Enabled = false;
    focusSingleTile = false;
    if (elapsed >= ZOOM_PHASE_MS) {
      cycleMode = "focus";
      cyclePhaseStartedAt = now;
      const to = getFocusCameraState();
      camX = to.x;
      camY = to.y;
      zoom = to.zoom;
      focusSingleTile = true;
    }
    return;
  }

  if (cycleMode === "focus") {
    texture10x10Enabled = false;
    focusSingleTile = true;
    if (elapsed >= FOCUS_PHASE_MS) {
      beginCameraZoomOut();
      cycleMode = "zoomOut";
      cyclePhaseStartedAt = now;
      focusSingleTile = false;
    }
    return;
  }

  if (cycleMode === "zoomOut") {
    texture10x10Enabled = false;
    focusSingleTile = false;
    if (elapsed >= ZOOM_PHASE_MS) {
      cycleMode = "grid";
      cyclePhaseStartedAt = now;
      texture10x10Enabled = true;
      focusSingleTile = false;
      const grid = getGridCameraState();
      camX = grid.x;
      camY = grid.y;
      zoom = grid.zoom;
    }
  }
}

function applyRandomJump() {
  if (!randomJumpEnabled) return;
  if (frameCount % JUMP_EVERY_N_FRAMES !== 0) return;
  const step = tileSize;
  const dx = (Math.floor(Math.random() * (2 * JUMP_RANGE_TILES + 1)) - JUMP_RANGE_TILES) * step;
  const dy = (Math.floor(Math.random() * (2 * JUMP_RANGE_TILES + 1)) - JUMP_RANGE_TILES) * step;
  if (texture10x10Enabled) {
    texI0 += dx / step;
    texJ0 += dy / step;
  } else if (focusSingleTile) {
    focusI += dx / step;
    focusJ += dy / step;
    updateCameraToFocusTile();
  } else {
    camX += dx;
    camY += dy;
  }
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
  const imageIdx = h1 % images.length;
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

function drawCameraView() {
  const cols = Math.ceil(width / (tileSize * zoom)) + 2;
  const rows = Math.ceil(height / (tileSize * zoom)) + 2;
  const centerI = Math.floor(camX / tileSize);
  const centerJ = Math.floor(camY / tileSize);
  const startI = centerI - Math.ceil(cols / 2);
  const endI = centerI + Math.ceil(cols / 2);
  const startJ = centerJ - Math.ceil(rows / 2);
  const endJ = centerJ + Math.ceil(rows / 2);

  for (let j = startJ; j <= endJ; j++) {
    for (let i = startI; i <= endI; i++) {
      drawTile(i, j);
    }
  }
}

function drawZoomCameraTransition() {
  const t = easeInOutCubic((millis() - cyclePhaseStartedAt) / ZOOM_PHASE_MS);
  camX = lerp(zoomCamFromX, zoomCamToX, t);
  camY = lerp(zoomCamFromY, zoomCamToY, t);
  zoom = lerp(zoomCamFromZoom, zoomCamToZoom, t);
  drawCameraView();
}

function drawFocusedImage() {
  const targetSize = Math.max(width, height);
  const sel = selectTier(targetSize, focusImageIdx);
  const src = sel.img;
  if (!src || !src.width) return;

  const fitted = fitRect(src.width, src.height, width, height);

  // Extend the image edges into any letterboxed area so the focus view still
  // feels full-screen without showing a second copy of the photo.
  if (fitted.x > 0) {
    image(src, 0, fitted.y, fitted.x, fitted.h, 0, 0, 1, src.height);
    image(
      src,
      fitted.x + fitted.w,
      fitted.y,
      width - (fitted.x + fitted.w),
      fitted.h,
      src.width - 1,
      0,
      1,
      src.height
    );
  }

  if (fitted.y > 0) {
    image(src, 0, 0, width, fitted.y, 0, 0, src.width, 1);
    image(
      src,
      0,
      fitted.y + fitted.h,
      width,
      height - (fitted.y + fitted.h),
      0,
      src.height - 1,
      src.width,
      1
    );
  }

  image(src, fitted.x, fitted.y, fitted.w, fitted.h);
}

function drawTexture10x10() {
  const { tiles, tilePx, x0, y0 } = getTextureGridLayout();

  for (let j = 0; j < tiles; j++) {
    for (let i = 0; i < tiles; i++) {
      const ii = texI0 + i;
      const jj = texJ0 + j;
      const { imageIdx } = tileFor(ii, jj);
      const sel = selectTier(tilePx, imageIdx);
      const src = sel.img;
      if (!src || !src.width) continue;

      const x = x0 + i * tilePx;
      const y = y0 + j * tilePx;
      const cover = coverRect(src.width, src.height, tilePx, tilePx);
      const fitted = fitRect(src.width, src.height, tilePx, tilePx);

      push();
      noStroke();
      drawingContext.save();
      drawingContext.beginPath();
      drawingContext.rect(x, y, tilePx, tilePx);
      drawingContext.clip();
      image(src, x + cover.x, y + cover.y, cover.w, cover.h);
      image(src, x + fitted.x, y + fitted.y, fitted.w, fitted.h);
      drawingContext.restore();
      pop();
    }
  }
}

function drawAllPhotosGrid() {
  const count = images.length;
  if (!count) return;

  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellSize = Math.max(1, Math.floor(Math.min(width / cols, height / rows)));
  const gridW = cols * cellSize;
  const gridH = rows * cellSize;
  const startX = Math.floor((width - gridW) / 2);
  const startY = Math.floor((height - gridH) / 2);

  let idx = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (idx >= count) return;

      const meta = images[idx];
      const targetSize = cellSize;
      const sel = selectTier(targetSize, idx);
      const src = sel.img;
      if (src && src.width) {
        const cellX = startX + col * cellSize;
        const cellY = startY + row * cellSize;
        const srcAspect = src.width / src.height;
        const cellAspect = 1;

        let sx = 0;
        let sy = 0;
        let sw = src.width;
        let sh = src.height;

        if (srcAspect > cellAspect) {
          sw = src.height * cellAspect;
          sx = (src.width - sw) / 2;
        } else {
          sh = src.width / cellAspect;
          sy = (src.height - sh) / 2;
        }

        push();
        noStroke();
        image(src, cellX, cellY, cellSize, cellSize, sx, sy, sw, sh);
        pop();
      }

      idx++;
    }
  }
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

  image(src, screenX, screenY, screenSize, screenSize, sx, sy, sw, sh);
}

// ----- Main loop -----
function draw() {
  background(0);
  if (!manifestLoaded) return;

  applyHeldKeys();
  updateCycleState();
  applyRandomJump();

  if (cycleMode === "zoom" || cycleMode === "zoomOut") {
    drawZoomCameraTransition();
  } else if (focusSingleTile) {
    drawFocusedImage();
  } else if (texture10x10Enabled) {
    drawTexture10x10();
  } else {
    drawAllPhotosGrid();
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
  const lines = [
    `photos ${images.length}`,
    `fps    ${fpsValue.toFixed(0)}`,
    `cache  full ${fulls.size}/${FULL_LRU_CAP}   med ${mediums.size}   loading ${loading.size}`,
    `view   ${
      cycleMode === "zoom"
        ? "camera zooming into random tile"
        : cycleMode === "zoomOut"
        ? "camera zooming back to 10x10 wall"
        : focusSingleTile
        ? "camera focused on random tile"
        : texture10x10Enabled
          ? "10x10 texture"
          : "all photos grid"
    }`,
    `keys   f fullscreen   c auto-cycle   g 10x10   t focus   r reseed`,
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
