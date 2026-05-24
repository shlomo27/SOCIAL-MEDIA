import {
  Engine, Scene, Vector3, Color3, Color4,
  HemisphericLight, DirectionalLight,
  MeshBuilder, Mesh, StandardMaterial,
  PBRMaterial, GlowLayer,
  FollowCamera, ArcRotateCamera,
  Path3D, Curve3,
  TransformNode, Matrix, Quaternion,
  VertexData, VertexBuffer,
  Animation, AnimationGroup,
  ParticleSystem, Texture, GPUParticleSystem,
} from "@babylonjs/core";
import "@babylonjs/core/Rendering/outlineRenderer";

// ═══════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════
const LAPS        = 3;
const ROAD_W      = 18;
const CAR_H       = 1.0;
const SEGS        = 240;
const NUM_AI      = 3;
const BASE_SPEED  = 22;   // units/sec
const MAX_SPEED   = 68;
const ACCEL       = 3.5;
const BRAKE       = 6.0;
const STEER_RATE  = 1.8;
const STEER_DAMP  = 0.72;
const FALL_LAT    = 1.22;
const FALL_T      = 2.4;
const UP          = Vector3.Up();

const POWERUP_TYPES = ["TURBO","ROCKET","SHIELD","MAGNET","BOMB","ICE","LIGHTNING"];
const POWERUP_ICONS = { TURBO:"⚡",ROCKET:"🚀",SHIELD:"🛡️",MAGNET:"🧲",BOMB:"💣",ICE:"❄️",LIGHTNING:"⚡" };
const POWERUP_COLS  = { TURBO:0xff8800,ROCKET:0xff2200,SHIELD:0x00aaff,MAGNET:0xff00ff,BOMB:0xff4400,ICE:0x88eeff,LIGHTNING:0xffff00 };

const CAR_COLORS = [0x00ccff, 0xff2244, 0x22ff88, 0xffaa00];

// ═══════════════════════════════════════════════════
//  LOADING UI
// ═══════════════════════════════════════════════════
const loadingEl   = document.getElementById("loadingScreen");
const loadingFill = document.getElementById("loadingFill");
const loadingText = document.getElementById("loadingText");
const hudEl       = document.getElementById("hud");
const countdownEl = document.getElementById("countdown");
const endEl       = document.getElementById("endScreen");

function setProgress(pct, text) {
  loadingFill.style.width = pct + "%";
  if (text) loadingText.textContent = text;
}

// ═══════════════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════════════
let audioCtx;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, type, dur, vol = 0.3, detune = 0) {
  try {
    const ctx = getAudio();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch {}
}
function playEngine(speed, maxSpeed) {
  // called every frame — handled by oscillator update
}

// ═══════════════════════════════════════════════════
//  TRACK GENERATION
// ═══════════════════════════════════════════════════
function buildTrackPoints() {
  const pts = [];
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 160 + Math.sin(a * 3) * 55 + Math.cos(a * 5) * 30;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // height variation: big drops and rises
    const y = Math.sin(a * 2) * 38 + Math.cos(a * 4) * 22 + Math.sin(a * 7 + 1) * 14;
    pts.push(new Vector3(x, y, z));
  }
  pts.push(pts[0].clone());  // close
  return pts;
}

function computeTrack(scene) {
  const pts = buildTrackPoints();
  const cat = Curve3.CreateCatmullRomSpline(pts, SEGS, true);
  const path3d = new Path3D(cat.getPoints());
  const points = path3d.getCurve();
  const tangents = path3d.getTangents();

  // flat binormals (always horizontal cross-section)
  const binormals = tangents.map(t => {
    const bi = Vector3.Cross(t, UP);
    return bi.length() < 0.001 ? new Vector3(1, 0, 0) : bi.normalize();
  });

  return { points, tangents, binormals, path3d };
}

function getTrackPoint(track, t) {
  const pts = track.points;
  const n   = pts.length - 1;
  const fi  = ((t % 1 + 1) % 1) * n;
  const i0  = Math.floor(fi) % n;
  const i1  = (i0 + 1) % n;
  const f   = fi - Math.floor(fi);
  return Vector3.Lerp(pts[i0], pts[i1], f);
}

function getTrackBi(track, t) {
  const bis = track.binormals;
  const n   = bis.length - 1;
  const fi  = ((t % 1 + 1) % 1) * n;
  const i0  = Math.floor(fi) % n;
  const i1  = (i0 + 1) % n;
  const f   = fi - Math.floor(fi);
  return Vector3.Lerp(bis[i0], bis[i1], f).normalize();
}

function getTrackTan(track, t) {
  const tans = track.tangents;
  const n    = tans.length - 1;
  const fi   = ((t % 1 + 1) % 1) * n;
  const i0   = Math.floor(fi) % n;
  const i1   = (i0 + 1) % n;
  const f    = fi - Math.floor(fi);
  return Vector3.Lerp(tans[i0], tans[i1], f).normalize();
}

// ═══════════════════════════════════════════════════
//  ROAD MESH
// ═══════════════════════════════════════════════════
function buildRoad(track, scene) {
  const pts = track.points;
  const bis = track.binormals;
  const n   = pts.length;

  const leftPath  = [];
  const rightPath = [];
  for (let i = 0; i < n; i++) {
    const p  = pts[i];
    const bi = bis[i];
    leftPath.push( p.add(bi.scale(-ROAD_W / 2)));
    rightPath.push(p.add(bi.scale( ROAD_W / 2)));
  }

  const road = MeshBuilder.CreateRibbon("road", {
    pathArray: [leftPath, rightPath],
    closePath: true,
    sideOrientation: Mesh.DOUBLESIDE,
  }, scene);

  const mat = new PBRMaterial("roadMat", scene);
  mat.albedoColor      = new Color3(0.06, 0.06, 0.15);
  mat.metallic         = 0.0;
  mat.roughness        = 0.85;
  mat.emissiveColor    = new Color3(0.02, 0.02, 0.06);
  road.material = mat;
  road.receiveShadows = false;

  // Guard rails
  buildRail(leftPath,  scene, new Color3(0, 1, 1));
  buildRail(rightPath, scene, new Color3(1, 0, 1));

  // Road markings (dashes)
  buildMarkings(pts, scene);

  return road;
}

function buildRail(path, scene, col) {
  const rail = MeshBuilder.CreateTube("rail", {
    path,
    radius: 0.28,
    tessellation: 5,
    cap: Mesh.CAP_ALL,
  }, scene);
  const mat = new PBRMaterial("railMat" + Math.random(), scene);
  mat.albedoColor   = Color3.Black();
  mat.emissiveColor = col;
  mat.metallic      = 0;
  mat.roughness     = 1;
  rail.material = mat;
}

function buildMarkings(pts, scene) {
  const step = Math.floor(pts.length / 60);
  for (let i = 0; i < pts.length; i += step) {
    const p0 = pts[i];
    const p1 = pts[(i + step) % pts.length];
    if (p0.subtract(p1).length() > 30) continue;
    const line = MeshBuilder.CreateLines("mark", {
      points: [p0, p1],
    }, scene);
    line.color = new Color3(1, 1, 0);
    line.alpha = 0.4;
  }
}

// ═══════════════════════════════════════════════════
//  CAR CREATION
// ═══════════════════════════════════════════════════
function buildCar(scene, colorHex, index) {
  const root = new TransformNode("car" + index, scene);

  const col = Color3.FromHexString(
    "#" + colorHex.toString(16).padStart(6, "0")
  );

  const bodyMat = new PBRMaterial("carBodyMat" + index, scene);
  bodyMat.albedoColor = col;
  bodyMat.metallic    = 0.7;
  bodyMat.roughness   = 0.2;
  bodyMat.clearCoat.isEnabled       = true;
  bodyMat.clearCoat.intensity       = 0.9;
  bodyMat.clearCoat.roughness       = 0.1;
  bodyMat.emissiveColor = col.scale(0.15);

  const body = MeshBuilder.CreateBox("body" + index, { width: 2.8, height: 0.6, depth: 5.0 }, scene);
  body.material = bodyMat;
  body.parent   = root;

  const topMat = new PBRMaterial("carTopMat" + index, scene);
  topMat.albedoColor = col.scale(0.7);
  topMat.metallic    = 0.5;
  topMat.roughness   = 0.3;
  topMat.clearCoat.isEnabled = true;
  topMat.clearCoat.intensity = 0.7;

  const top = MeshBuilder.CreateBox("top" + index, { width: 2.1, height: 0.62, depth: 2.1 }, scene);
  top.position.y = 0.61;
  top.position.z = 0.3;
  top.material   = topMat;
  top.parent     = root;

  // Spoiler
  const wingMat = new PBRMaterial("wingMat" + index, scene);
  wingMat.albedoColor = Color3.FromHexString("#111111");
  wingMat.metallic    = 0.9;
  wingMat.roughness   = 0.15;

  const wing = MeshBuilder.CreateBox("wing" + index, { width: 3.2, height: 0.08, depth: 0.6 }, scene);
  wing.position.y = 0.95;
  wing.position.z = -2.3;
  wing.material   = wingMat;
  wing.parent     = root;

  // Headlights (emissive)
  const lightMat = new PBRMaterial("lightMat" + index, scene);
  lightMat.albedoColor  = Color3.White();
  lightMat.emissiveColor = new Color3(1, 1, 0.8);
  lightMat.metallic      = 0;
  lightMat.roughness     = 1;

  for (const side of [-1, 1]) {
    const hl = MeshBuilder.CreateBox("hl" + index + side, { width: 0.5, height: 0.2, depth: 0.12 }, scene);
    hl.position.set(side * 1.05, 0, 2.52);
    hl.material = lightMat;
    hl.parent   = root;
  }

  // Tail-lights (red emissive)
  const tailMat = new PBRMaterial("tailMat" + index, scene);
  tailMat.albedoColor   = Color3.Black();
  tailMat.emissiveColor = new Color3(1, 0.04, 0.04);
  tailMat.metallic      = 0;
  tailMat.roughness     = 1;

  for (const side of [-1, 1]) {
    const tl = MeshBuilder.CreateBox("tl" + index + side, { width: 0.5, height: 0.18, depth: 0.12 }, scene);
    tl.position.set(side * 1.05, 0, -2.52);
    tl.material = tailMat;
    tl.parent   = root;
  }

  // Wheels
  const tyreMat = new PBRMaterial("tyreMat" + index, scene);
  tyreMat.albedoColor = new Color3(0.07, 0.07, 0.07);
  tyreMat.metallic    = 0;
  tyreMat.roughness   = 0.95;

  const rimMat = new PBRMaterial("rimMat" + index, scene);
  rimMat.albedoColor = new Color3(0.85, 0.85, 0.85);
  rimMat.metallic    = 0.95;
  rimMat.roughness   = 0.1;

  const wheelPos = [
    [-1.55,  1.9], [-1.55, -1.9],
    [ 1.55,  1.9], [ 1.55, -1.9],
  ];
  for (const [sx, sz] of wheelPos) {
    const tyre = MeshBuilder.CreateCylinder("tyre" + index, { diameter: 1.1, height: 0.4, tessellation: 14 }, scene);
    tyre.rotation.z = Math.PI / 2;
    tyre.position.set(sx, -0.22, sz);
    tyre.material = tyreMat;
    tyre.parent   = root;

    const rim = MeshBuilder.CreateCylinder("rim" + index, { diameter: 0.68, height: 0.42, tessellation: 8 }, scene);
    rim.rotation.z = Math.PI / 2;
    rim.position.set(sx, -0.22, sz);
    rim.material = rimMat;
    rim.parent   = root;
  }

  return root;
}

// ═══════════════════════════════════════════════════
//  POWERUP PICKUPS
// ═══════════════════════════════════════════════════
function buildPowerupMeshPool(scene) {
  const pool = [];
  for (let i = 0; i < 12; i++) {
    const box = MeshBuilder.CreateBox("pu" + i, { size: 2.2 }, scene);
    const mat = new PBRMaterial("puMat" + i, scene);
    mat.albedoColor   = Color3.Black();
    mat.emissiveColor = new Color3(1, 1, 0);
    mat.metallic      = 0;
    mat.roughness     = 1;
    box.material      = mat;
    box.isVisible     = false;
    pool.push({ mesh: box, mat, active: false, t: 0, type: "" });
  }
  return pool;
}

// ═══════════════════════════════════════════════════
//  PARTICLES (POOL)
// ═══════════════════════════════════════════════════
const MAX_PAR = 150;

function buildParticlePool(scene) {
  const pool = [];
  const geo  = { diameter: 0.4, tessellation: 3 };
  const mat  = new StandardMaterial("parMat", scene);
  mat.disableLighting = true;
  mat.emissiveColor   = Color3.White();

  for (let i = 0; i < MAX_PAR; i++) {
    const m = MeshBuilder.CreateSphere("par" + i, geo, scene);
    m.material  = mat.clone();
    m.isVisible = false;
    m.isPickable = false;
    pool.push({ mesh: m, active: false, vel: Vector3.Zero(), life: 0, maxLife: 1 });
  }
  return pool;
}

function spawnParticles(pool, pos, count, vel, col, life = 0.6) {
  let spawned = 0;
  for (const p of pool) {
    if (p.active) continue;
    if (spawned >= count) break;
    p.mesh.isVisible = true;
    p.mesh.position.copyFrom(pos);
    p.mesh.material.emissiveColor = col;
    p.vel = new Vector3(
      vel.x + (Math.random() - 0.5) * 6,
      vel.y + Math.random() * 4,
      vel.z + (Math.random() - 0.5) * 6
    );
    p.life    = life;
    p.maxLife = life;
    p.active  = true;
    spawned++;
  }
}

function updateParticles(pool, dt) {
  for (const p of pool) {
    if (!p.active) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.active = false;
      p.mesh.isVisible = false;
      continue;
    }
    p.mesh.position.addInPlace(p.vel.scale(dt));
    p.vel.y -= 9.8 * dt;
    const ratio = p.life / p.maxLife;
    p.mesh.scaling.setAll(ratio * 0.9 + 0.1);
    p.mesh.material.alpha = ratio;
  }
}

// ═══════════════════════════════════════════════════
//  PLACE CAR ON TRACK
// ═══════════════════════════════════════════════════
function placeOnTrack(root, track, t, lat) {
  const p   = getTrackPoint(track, t);
  const bi  = getTrackBi(track, t);
  const pos = p.add(bi.scale(lat * ROAD_W * 0.65)).add(new Vector3(0, CAR_H, 0));
  root.position.copyFrom(pos);

  // Orient car: face forward along track, world-upright
  const tBack = ((t - 0.004 + 1) % 1);
  const pBack = getTrackPoint(track, tBack).add(getTrackBi(track, tBack).scale(lat * ROAD_W * 0.65)).add(new Vector3(0, CAR_H, 0));

  const fwd = pos.subtract(pBack).normalize();
  const right = Vector3.Cross(UP, fwd).normalize();
  const up2   = Vector3.Cross(fwd, right).normalize();

  if (right.length() < 0.01) return;

  const mat = Matrix.FromValues(
    right.x, up2.x, fwd.x, 0,
    right.y, up2.y, fwd.y, 0,
    right.z, up2.z, fwd.z, 0,
    0, 0, 0, 1
  );
  const quat = Quaternion.FromRotationMatrix(mat);
  root.rotationQuaternion = quat;
}

// ═══════════════════════════════════════════════════
//  POSITION SUFFIX
// ═══════════════════════════════════════════════════
function suffix(n) {
  if (n === 1) return "ST";
  if (n === 2) return "ND";
  if (n === 3) return "RD";
  return "TH";
}

// ═══════════════════════════════════════════════════
//  MINIMAP
// ═══════════════════════════════════════════════════
const mmCanvas = document.getElementById("minimapCanvas");
const mmCtx    = mmCanvas.getContext("2d");
const MM_SIZE  = 120;

let mmTrackPts = null;

function buildMinimapTrack(track) {
  const pts = track.points;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const sw = maxX - minX, sh = maxZ - minZ, sc = Math.max(sw, sh);
  const pad = 10;
  mmTrackPts = pts.map(p => ({
    x: pad + ((p.x - minX) / sc) * (MM_SIZE - pad * 2),
    y: pad + ((p.z - minZ) / sc) * (MM_SIZE - pad * 2),
  }));
}

function drawMinimap(cars) {
  if (!mmTrackPts) return;
  mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);

  // Track line
  mmCtx.beginPath();
  mmCtx.strokeStyle = "#0ff4";
  mmCtx.lineWidth   = 2;
  mmCtx.moveTo(mmTrackPts[0].x, mmTrackPts[0].y);
  for (const p of mmTrackPts) mmCtx.lineTo(p.x, p.y);
  mmCtx.closePath();
  mmCtx.stroke();

  const scale = (mm, t) => {
    const pts = mmTrackPts;
    const n   = pts.length - 1;
    const fi  = ((t % 1 + 1) % 1) * n;
    const i0  = Math.floor(fi) % n;
    const i1  = (i0 + 1) % n;
    const f   = fi - Math.floor(fi);
    return {
      x: pts[i0].x + (pts[i1].x - pts[i0].x) * f,
      y: pts[i0].y + (pts[i1].y - pts[i0].y) * f,
    };
  };

  const dotCols = ["#0ff", "#f44", "#2f8", "#fa0"];
  for (let i = 0; i < cars.length; i++) {
    const cd  = cars[i].userData;
    const dot = scale(mmTrackPts, cd.t);
    mmCtx.beginPath();
    mmCtx.arc(dot.x, dot.y, i === 0 ? 5 : 3.5, 0, Math.PI * 2);
    mmCtx.fillStyle = i === 0 ? "#fff" : dotCols[i];
    mmCtx.fill();
  }
}

// ═══════════════════════════════════════════════════
//  MAIN GAME
// ═══════════════════════════════════════════════════
async function main() {
  setProgress(5, "STARTING ENGINE...");

  const canvas = document.getElementById("gameCanvas");
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: false,
    doNotHandleContextLost: false,
    limitDeviceRatio: Math.min(window.devicePixelRatio, 2),
  });

  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.01, 0.01, 0.04, 1);
  scene.fogMode    = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.004;
  scene.fogColor   = new Color3(0.01, 0.01, 0.08);

  setProgress(15, "BUILDING WORLD...");
  await nextFrame();

  // ── Lights ──
  const ambient = new HemisphericLight("amb", new Vector3(0, 1, 0), scene);
  ambient.intensity    = 0.35;
  ambient.diffuse      = new Color3(0.3, 0.3, 0.5);
  ambient.groundColor  = new Color3(0.08, 0.08, 0.15);

  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.3), scene);
  sun.intensity = 0.8;
  sun.diffuse   = new Color3(0.9, 0.85, 1.0);

  // ── Glow layer ──
  const glow = new GlowLayer("glow", scene);
  glow.intensity          = 1.4;
  glow.blurKernelSize     = 32;
  glow.isEnabled          = true;

  // ── Skybox (gradient via background mesh) ──
  const sky = MeshBuilder.CreateSphere("sky", { diameter: 1800, sideOrientation: Mesh.BACKSIDE }, scene);
  const skyMat = new StandardMaterial("skyMat", scene);
  skyMat.emissiveColor     = new Color3(0.01, 0.01, 0.06);
  skyMat.disableLighting   = true;
  skyMat.backFaceCulling   = false;
  sky.material = skyMat;
  sky.isPickable = false;

  // Stars
  const starPts = [];
  for (let i = 0; i < 600; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    starPts.push(new Vector3(Math.sin(ph) * Math.cos(th) * 800, Math.cos(ph) * 800, Math.sin(ph) * Math.sin(th) * 800));
  }
  const stars = MeshBuilder.CreatePointsCloud("stars", { points: starPts }, scene);
  stars.material = (() => {
    const m = new StandardMaterial("starMat", scene); m.emissiveColor = Color3.White(); m.disableLighting = true; return m;
  })();

  setProgress(30, "BUILDING TRACK...");
  await nextFrame();

  // ── Track ──
  const track = computeTrack(scene);
  buildRoad(track, scene);
  buildMinimapTrack(track);

  setProgress(50, "SPAWNING CARS...");
  await nextFrame();

  // ── Cars ──
  const carMeshes = [];
  const numCars = 1 + NUM_AI;
  for (let i = 0; i < numCars; i++) {
    const mesh = buildCar(scene, CAR_COLORS[i], i);
    const data = {
      t: -i * 0.015,         // stagger start positions
      lat: (i % 2 === 0 ? -1 : 1) * 0.25,
      speed: BASE_SPEED,
      steer: 0,
      lap: 0,
      lapProgress: 0,
      totalDist: 0,
      falling: false,
      fallTimer: 0,
      ai: i > 0,
      isPlayer: i === 0,
      powerup: null,
      powerupTimer: 0,
      shield: false,
      ice: false,
      iceTimer: 0,
      stunTimer: 0,
      color: CAR_COLORS[i],
    };
    mesh.userData = data;
    carMeshes.push(mesh);
    placeOnTrack(mesh, track, data.t, data.lat);
  }
  const playerCar = carMeshes[0];

  // ── Powerup pickups ──
  const puPool = buildPowerupMeshPool(scene);
  const pickups = [];
  for (let i = 0; i < 10; i++) {
    const t    = i / 10;
    const type = POWERUP_TYPES[i % POWERUP_TYPES.length];
    const pu   = puPool[i];
    const hexCol = POWERUP_COLS[type];
    pu.mat.emissiveColor = Color3.FromHexString("#" + hexCol.toString(16).padStart(6, "0"));
    pu.t    = t;
    pu.type = type;
    pu.active = true;
    pu.mesh.isVisible = true;
    pu.respawn = 0;
    pickups.push(pu);
  }

  function positionPickup(pu) {
    const p  = getTrackPoint(track, pu.t);
    const bi = getTrackBi(track, pu.t);
    pu.mesh.position.copyFrom(p.add(new Vector3(0, CAR_H + 1.4, 0)));
  }
  for (const pu of pickups) positionPickup(pu);

  // ── Particle pool ──
  const parPool = buildParticlePool(scene);

  // ── Camera ──
  const camera = new ArcRotateCamera("cam", 0, 0, 10, Vector3.Zero(), scene);
  camera.minZ = 0.5;
  camera.maxZ = 2000;

  // Manual camera target
  let camPos  = playerCar.position.clone().add(new Vector3(0, 6, -14));
  let camLook = playerCar.position.clone();

  // ── Input ──
  const keys = {};
  window.addEventListener("keydown", e => { keys[e.code] = true; });
  window.addEventListener("keyup",   e => { keys[e.code] = false; });

  let touchLeft = false, touchRight = false, touchUse = false;
  const tlBtn = document.getElementById("touch-left");
  const trBtn = document.getElementById("touch-right");
  const tuBtn = document.getElementById("touch-use");

  for (const [el, setter] of [[tlBtn, v => touchLeft = v], [trBtn, v => touchRight = v], [tuBtn, v => touchUse = v]]) {
    el.addEventListener("touchstart", e => { e.preventDefault(); setter(true); el.classList.add("pressed"); }, { passive: false });
    el.addEventListener("touchend",   e => { e.preventDefault(); setter(false); el.classList.remove("pressed"); }, { passive: false });
  }

  // Gyroscope
  let gyroY = 0;
  window.addEventListener("deviceorientation", e => {
    if (e.gamma !== null) gyroY = Math.max(-45, Math.min(45, e.gamma)) / 45;
  });

  setProgress(70, "LIGHTING NEONS...");
  await nextFrame();

  // ── Track lights ──
  const trackLightColors = [
    new Color3(0, 1, 1), new Color3(1, 0, 1),
    new Color3(0, 0.5, 1), new Color3(1, 0.5, 0),
  ];
  for (let i = 0; i < 16; i++) {
    const t    = i / 16;
    const p    = getTrackPoint(track, t);
    const post = MeshBuilder.CreateCylinder("post" + i, { height: 8, diameter: 0.25, tessellation: 6 }, scene);
    post.position.copyFrom(p.add(new Vector3(0, 3, 0)));
    const col = trackLightColors[i % trackLightColors.length];
    const lm  = new PBRMaterial("lm" + i, scene);
    lm.albedoColor   = Color3.Black();
    lm.emissiveColor = col;
    lm.metallic      = 0;
    lm.roughness     = 1;
    post.material = lm;
  }

  setProgress(90, "STARTING RACE...");
  await nextFrame();

  // ── HUD elements ──
  const posNum    = document.getElementById("pos-num");
  const posSuf    = document.getElementById("pos-suffix");
  const lapNum    = document.getElementById("lap-num");
  const speedNum  = document.getElementById("speed-num");
  const puDisplay = document.getElementById("powerup-display");
  const puIcon    = document.getElementById("powerup-icon");
  const puName    = document.getElementById("powerup-name");

  // ── Game state ──
  let raceStarted   = false;
  let raceFinished  = false;
  let countdownVal  = 3;
  let raceTime      = 0;
  let playerFinPos  = 0;
  let finishCount   = 0;
  let usePowerup    = false;

  // ── Countdown ──
  setProgress(100, "GO!");
  loadingEl.classList.add("fade-out");
  setTimeout(() => loadingEl.style.display = "none", 700);

  hudEl.classList.remove("hidden");
  countdownEl.classList.remove("hidden");

  async function runCountdown() {
    for (let c = 3; c >= 1; c--) {
      countdownEl.textContent = c;
      countdownEl.style.animation = "none";
      void countdownEl.offsetWidth; // force reflow
      countdownEl.style.animation = "countPop 0.6s ease-out";
      playTone(440, "square", 0.25, 0.3);
      await sleep(900);
    }
    countdownEl.textContent = "GO!";
    countdownEl.style.color = "#0f0";
    countdownEl.style.textShadow = "0 0 40px #0f0, 0 0 80px #0f0";
    countdownEl.style.animation = "none";
    void countdownEl.offsetWidth;
    countdownEl.style.animation = "countPop 0.6s ease-out";
    playTone(880, "sawtooth", 0.4, 0.4);
    raceStarted = true;
    await sleep(700);
    countdownEl.classList.add("hidden");
  }
  runCountdown();

  // ── Engine oscillator for player ──
  let engineOsc = null, engineGain = null;
  try {
    const ctx   = getAudio();
    engineOsc   = ctx.createOscillator();
    engineGain  = ctx.createGain();
    engineOsc.connect(engineGain);
    engineGain.connect(ctx.destination);
    engineOsc.type      = "sawtooth";
    engineOsc.frequency.value = 80;
    engineGain.gain.value     = 0.04;
    engineOsc.start();
  } catch {}

  // ═══════════════════════════════════════════════
  //  UPDATE LOOP
  // ═══════════════════════════════════════════════
  let lastT = performance.now();

  scene.registerBeforeRender(() => {
    const now = performance.now();
    const dt  = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    if (!raceStarted || raceFinished) return;
    raceTime += dt;

    // Rotate pickups
    for (const pu of pickups) {
      if (pu.active) {
        pu.mesh.rotation.y += dt * 1.8;
        pu.mesh.rotation.x += dt * 0.9;
        // Bob
        const p = getTrackPoint(track, pu.t);
        pu.mesh.position.y = p.y + CAR_H + 1.4 + Math.sin(raceTime * 2.5 + pu.t * 50) * 0.4;
      } else if (pu.respawn > 0) {
        pu.respawn -= dt;
        if (pu.respawn <= 0) {
          pu.active = true;
          pu.mesh.isVisible = true;
          pu.type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
          pu.mat.emissiveColor = Color3.FromHexString("#" + POWERUP_COLS[pu.type].toString(16).padStart(6, "0"));
        }
      }
    }

    // Update each car
    for (let ci = 0; ci < carMeshes.length; ci++) {
      const car = carMeshes[ci];
      const d   = car.userData;

      if (d.stunTimer > 0) {
        d.stunTimer -= dt;
        d.speed *= 0.9;
        continue;
      }

      // ── Speed update ──
      const topSpeed = d.powerup === "TURBO"  ? MAX_SPEED * 1.35
                     : d.powerup === "ROCKET" ? MAX_SPEED * 1.6
                     : MAX_SPEED;

      if (d.ai) {
        // AI always accelerates toward target speed
        d.speed = Math.min(d.speed + ACCEL * dt * (0.85 + ci * 0.05), topSpeed * 0.92);
      } else {
        // Player
        if (keys["ArrowUp"] || keys["KeyW"]) {
          d.speed = Math.min(d.speed + ACCEL * dt, topSpeed);
        } else if (keys["ArrowDown"] || keys["KeyS"]) {
          d.speed = Math.max(d.speed - BRAKE * dt, 4);
        } else {
          d.speed = Math.max(d.speed - 1.5 * dt, BASE_SPEED);
        }
        d.speed = Math.min(d.speed, topSpeed);
      }

      // ── Steering ──
      let steerInput = 0;
      if (d.ai) {
        // AI: steer to stay near center (±0.3 random bias)
        const targetLat = d.aiTargetLat || 0;
        steerInput = Math.max(-1, Math.min(1, (targetLat - d.lat) * 2.5));
        // Occasionally change target lane
        if (!d.aiNextLane || raceTime > d.aiNextLane) {
          d.aiTargetLat = (Math.random() - 0.5) * 0.8;
          d.aiNextLane  = raceTime + 1.5 + Math.random() * 2;
        }
      } else {
        if (keys["ArrowLeft"]  || keys["KeyA"] || touchLeft)  steerInput -= 1;
        if (keys["ArrowRight"] || keys["KeyD"] || touchRight) steerInput += 1;
        if (Math.abs(gyroY) > 0.08) steerInput += gyroY * 1.2;
        steerInput = Math.max(-1, Math.min(1, steerInput));

        // Use powerup
        if ((keys["Space"] || keys["KeyE"] || touchUse) && !usePowerup) {
          usePowerup = true;
          activatePowerup(d, carMeshes, parPool, track);
        }
        if (!keys["Space"] && !keys["KeyE"] && !touchUse) usePowerup = false;
      }

      if (d.ice) steerInput *= 0.35;

      d.steer += (steerInput - d.steer) * (1 - Math.pow(STEER_DAMP, dt * 60));

      // ── Move along track ──
      const tAdv = (d.speed * dt) / (track.points.length * 2.2);
      d.t += tAdv;
      d.lat += d.steer * STEER_RATE * dt;
      d.lat = Math.max(-1.3, Math.min(1.3, d.lat));
      d.totalDist += d.speed * dt;

      // Track t wrapping and lap counting
      const prevLap = Math.floor(d.lap);
      if (d.t > 1 && d.lapProgress > 0.5) {
        d.lap++;
        d.lapProgress = 0;
        d.t -= 1;
        if (!d.ai) {
          lapNum.textContent = Math.min(d.lap + 1, LAPS);
          playTone(660, "square", 0.3, 0.35);
          spawnParticles(parPool, car.position, 20,
            new Vector3(0, 3, 0), new Color3(0, 1, 1), 0.8);
        }
        if (d.lap >= LAPS) {
          finishCount++;
          if (d.isPlayer) {
            playerFinPos  = finishCount;
            raceFinished  = true;
            showEndScreen(playerFinPos, raceTime);
          }
          d.speed = BASE_SPEED * 0.5;
        }
      }
      if (d.t > 0.5) d.lapProgress = 1;

      // ── Fall detection ──
      if (Math.abs(d.lat) > FALL_LAT) {
        d.fallTimer += dt;
        if (d.fallTimer > 0.25) {
          // Respawn
          spawnParticles(parPool, car.position, 25,
            new Vector3(0, 2, 0), new Color3(1, 0.3, 0), 0.9);
          d.lat = 0;
          d.t   = ((d.t % 1) + 1) % 1;
          d.t   = Math.max(0, d.t - 0.02);
          d.speed = BASE_SPEED * 0.7;
          d.fallTimer = 0;
          if (!d.ai) playTone(200, "sawtooth", 0.5, 0.3);
        }
      } else {
        d.fallTimer = 0;
      }

      // ── Place on track ──
      placeOnTrack(car, track, d.t, d.lat);

      // ── Powerup timer ──
      if (d.powerup && d.powerupTimer > 0) {
        d.powerupTimer -= dt;
        if (d.powerupTimer <= 0) {
          d.powerup  = null;
          d.shield   = false;
          d.ice      = false;
          if (!d.ai) updatePowerupHUD(null);
        }
      }
      if (d.ice) {
        d.iceTimer -= dt;
        if (d.iceTimer <= 0) d.ice = false;
      }

      // ── Pickup collection ──
      for (const pu of pickups) {
        if (!pu.active) continue;
        const puPos = getTrackPoint(track, pu.t).add(new Vector3(0, CAR_H + 1.4, 0));
        const dist  = Vector3.Distance(car.position, puPos);
        if (dist < 4.5) {
          pu.active = false;
          pu.mesh.isVisible = false;
          pu.respawn = 8 + Math.random() * 5;
          if (!d.ai) {
            d.powerup      = pu.type;
            d.powerupTimer = 12;
            updatePowerupHUD(pu.type);
            playTone(550, "square", 0.2, 0.3);
          } else {
            // AI immediately uses bomb/ice on player
            if (pu.type === "BOMB" || pu.type === "ICE" || pu.type === "LIGHTNING") {
              const pd = playerCar.userData;
              const pDist = Vector3.Distance(car.position, playerCar.position);
              if (pDist < 30) {
                if (pu.type === "BOMB") { pd.stunTimer = 1.8; spawnParticles(parPool, playerCar.position, 30, new Vector3(0,5,0), new Color3(1,0.5,0), 1.0); playTone(180,"sawtooth",0.4,0.4); }
                if (pu.type === "ICE")  { pd.ice = true; pd.iceTimer = 3; spawnParticles(parPool, playerCar.position, 20, new Vector3(0,2,0), new Color3(0.5,0.9,1), 0.7); }
                if (pu.type === "LIGHTNING") { pd.stunTimer = 1.2; spawnParticles(parPool, playerCar.position, 15, new Vector3(0,3,0), new Color3(1,1,0), 0.5); }
              }
            }
          }
          break;
        }
      }
    }

    // ── AI ramming ──
    for (let i = 1; i < carMeshes.length; i++) {
      const ai  = carMeshes[i];
      const pd  = playerCar.userData;
      const dist = Vector3.Distance(ai.position, playerCar.position);
      if (dist < 5.5 && !pd.shield) {
        const pushDir = playerCar.position.subtract(ai.position).normalize();
        pd.lat   += pushDir.x * 0.25;
        pd.speed *= 0.88;
        if (Math.random() < 0.1) playTone(220, "square", 0.15, 0.25);
      }
    }

    // ── Race positions ──
    const sorted = [...carMeshes].sort((a, b) => {
      const ad = a.userData, bd = b.userData;
      const at = ad.lap + ((ad.t % 1 + 1) % 1);
      const bt = bd.lap + ((bd.t % 1 + 1) % 1);
      return bt - at;
    });
    const pos = sorted.indexOf(playerCar) + 1;
    posNum.textContent = pos;
    posSuf.textContent = suffix(pos);

    // ── Speed HUD ──
    const kmh = Math.round(playerCar.userData.speed * 3.6 * 0.52);
    speedNum.textContent = kmh;

    // ── Engine sound ──
    if (engineOsc) {
      const freq = 60 + (playerCar.userData.speed / MAX_SPEED) * 220;
      engineOsc.frequency.setTargetAtTime(freq, getAudio().currentTime, 0.1);
    }

    // ── Camera ──
    updateCamera(camera, playerCar, track, dt, camPos, camLook);

    // ── Particles ──
    updateParticles(parPool, dt);

    // ── Exhaust particles ──
    if (Math.random() < 0.35) {
      const ex = playerCar.position.add(new Vector3(0, -0.2, -2.6));
      const spd = playerCar.userData.speed;
      const col = spd > BASE_SPEED * 1.5 ? new Color3(0, 0.8, 1) : new Color3(0.6, 0.6, 0.6);
      spawnParticles(parPool, ex, 1, new Vector3((Math.random()-0.5)*2, 1, -spd*0.04), col, 0.3);
    }

    // ── Minimap ──
    drawMinimap(carMeshes);
  });

  // ═══════════════════════════════════════════════
  //  CAMERA
  // ═══════════════════════════════════════════════
  const _camPos  = new Vector3();
  const _camLook = new Vector3();

  function updateCamera(cam, target, track, dt, cp, cl) {
    const d   = target.userData;
    const tan = getTrackTan(track, ((d.t % 1 + 1) % 1));
    const flatTan = new Vector3(tan.x, tan.y * 0.2, tan.z).normalize();

    const back  = d.powerup === "ROCKET" ? 20 : 14;
    const rise  = 6;
    const ahead = 12;

    const idealPos  = target.position.subtract(flatTan.scale(back)).add(new Vector3(0, rise, 0));
    const idealLook = target.position.add(flatTan.scale(ahead));

    const alpha = Math.min(dt * 9, 1);
    Vector3.LerpToRef(cp, idealPos,  alpha, _camPos);
    Vector3.LerpToRef(cl, idealLook, Math.min(dt * 11, 1), _camLook);
    cp.copyFrom(_camPos);
    cl.copyFrom(_camLook);

    cam.position.copyFrom(_camPos);
    cam.setTarget(_camLook);
    cam.upVector.copyFromFloats(0, 1, 0);
  }

  // ═══════════════════════════════════════════════
  //  POWERUP ACTIVATION
  // ═══════════════════════════════════════════════
  function activatePowerup(d, cars, parPool, track) {
    if (!d.powerup || d.ai) return;
    const type = d.powerup;
    playTone(770, "square", 0.3, 0.4);

    if (type === "TURBO") {
      d.speed = Math.min(d.speed + 28, MAX_SPEED * 1.35);
      spawnParticles(parPool, playerCar.position, 20, new Vector3(0, 2, 0), new Color3(0, 1, 1), 0.6);

    } else if (type === "ROCKET") {
      d.speed = MAX_SPEED * 1.6;
      d.powerupTimer = 4;
      spawnParticles(parPool, playerCar.position, 30, new Vector3(0, 3, 0), new Color3(1, 0.4, 0), 0.8);

    } else if (type === "SHIELD") {
      d.shield = true;
      d.powerupTimer = 8;
      spawnParticles(parPool, playerCar.position, 15, new Vector3(0, 2, 0), new Color3(0, 0.6, 1), 0.6);

    } else if (type === "MAGNET") {
      // Pull forward
      d.t += 0.025;
      d.speed = Math.min(d.speed + 18, MAX_SPEED);
      spawnParticles(parPool, playerCar.position, 18, new Vector3(0, 2, 0), new Color3(1, 0, 1), 0.6);

    } else if (type === "BOMB") {
      // Stun nearest AI
      let nearest = null, minDist = Infinity;
      for (const c of cars) {
        if (c === playerCar) continue;
        const dist = Vector3.Distance(c.position, playerCar.position);
        if (dist < minDist) { minDist = dist; nearest = c; }
      }
      if (nearest && minDist < 35) {
        nearest.userData.stunTimer = 2.2;
        spawnParticles(parPool, nearest.position, 35, new Vector3(0, 5, 0), new Color3(1, 0.5, 0), 1.0);
        playTone(150, "sawtooth", 0.5, 0.45);
      }

    } else if (type === "ICE") {
      // Ice all AIs
      for (const c of cars) {
        if (c === playerCar) continue;
        c.userData.ice = true; c.userData.iceTimer = 3;
        spawnParticles(parPool, c.position, 15, new Vector3(0, 2, 0), new Color3(0.5, 0.9, 1), 0.7);
      }

    } else if (type === "LIGHTNING") {
      // Stun all AIs
      for (const c of cars) {
        if (c === playerCar) continue;
        c.userData.stunTimer = 1.5;
        spawnParticles(parPool, c.position, 15, new Vector3(0, 3, 0), new Color3(1, 1, 0), 0.5);
      }
      playTone(1000, "sawtooth", 0.4, 0.4);
    }

    d.powerup      = null;
    d.powerupTimer = 0;
    updatePowerupHUD(null);
  }

  // ── Powerup HUD ──
  function updatePowerupHUD(type) {
    if (!type) { puDisplay.classList.add("hidden"); return; }
    puDisplay.classList.remove("hidden");
    puIcon.textContent = POWERUP_ICONS[type] || "?";
    puName.textContent = type;
  }

  // ── End screen ──
  function showEndScreen(pos, time) {
    endEl.classList.remove("hidden");
    const m = Math.floor(time / 60), s = Math.floor(time % 60), ms = Math.floor((time % 1) * 100);
    document.getElementById("end-position").textContent =
      pos === 1 ? "1ST PLACE — WINNER!" : pos + suffix(pos) + " PLACE";
    document.getElementById("end-time").textContent =
      `TIME: ${m}:${String(s).padStart(2,"0")}.${String(ms).padStart(2,"0")}`;
    playTone(880, "square", 0.1, 0.4);
    setTimeout(() => playTone(1100, "square", 0.1, 0.4), 150);
    setTimeout(() => playTone(1320, "square", 0.3, 0.4), 300);
  }

  document.getElementById("restartBtn").addEventListener("click", () => {
    window.location.reload();
  });

  // ── Start render loop ──
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

// ═══════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════
function nextFrame() {
  return new Promise(r => requestAnimationFrame(r));
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(console.error);
