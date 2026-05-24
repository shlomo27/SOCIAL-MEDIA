import {
  Engine, Scene, Vector3, Color3, Color4,
  HemisphericLight, DirectionalLight,
  MeshBuilder, Mesh, StandardMaterial,
  PBRMaterial, GlowLayer,
  UniversalCamera,
  Path3D, Curve3,
  TransformNode, Matrix, Quaternion,
} from "@babylonjs/core";

// ═══════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════
const LAPS       = 3;
const ROAD_W     = 18;
const CAR_H      = 1.2;
const NUM_AI     = 3;
const BASE_SPEED = 22;
const MAX_SPEED  = 68;
const ACCEL      = 3.5;
const BRAKE      = 6.0;
const STEER_RATE = 1.8;
const STEER_DAMP = 0.72;
const FALL_LAT   = 1.25;
const UP         = Vector3.Up();

const POWERUP_TYPES = ["TURBO","ROCKET","SHIELD","MAGNET","BOMB","ICE","LIGHTNING"];
const POWERUP_ICONS = { TURBO:"⚡",ROCKET:"🚀",SHIELD:"🛡️",MAGNET:"🧲",BOMB:"💣",ICE:"❄️",LIGHTNING:"⚡" };
const POWERUP_COLS  = { TURBO:"#ff8800",ROCKET:"#ff2200",SHIELD:"#00aaff",MAGNET:"#ff00ff",BOMB:"#ff4400",ICE:"#88eeff",LIGHTNING:"#ffff00" };
const CAR_COLORS    = [0x00ccff, 0xff2244, 0x22ff88, 0xffaa00];

// ═══════════════════════════════════════
//  DOM
// ═══════════════════════════════════════
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
function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════
let audioCtx;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, type, dur, vol = 0.3) {
  try {
    const ctx = getAudio();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch {}
}

// ═══════════════════════════════════════
//  TRACK
// ═══════════════════════════════════════
function buildTrackPoints() {
  const pts = [];
  const N = 20;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 160 + Math.sin(a * 3) * 50 + Math.cos(a * 5) * 25;
    pts.push(new Vector3(
      Math.cos(a) * r,
      Math.sin(a * 2) * 32 + Math.cos(a * 4) * 18,
      Math.sin(a) * r
    ));
  }
  pts.push(pts[0].clone());
  return pts;
}

function computeTrack() {
  const ctrlPts = buildTrackPoints();
  // 10 subdivisions per control point = ~200 total points
  const spline  = Curve3.CreateCatmullRomSpline(ctrlPts, 10, true);
  const raw     = spline.getPoints();

  const tangents  = [];
  const binormals = [];

  for (let i = 0; i < raw.length; i++) {
    const prev = raw[(i - 1 + raw.length) % raw.length];
    const next = raw[(i + 1) % raw.length];
    const tan  = next.subtract(prev).normalize();
    tangents.push(tan);

    let bi = Vector3.Cross(tan, UP);
    if (bi.length() < 0.001) bi = new Vector3(1, 0, 0);
    binormals.push(bi.normalize());
  }

  return { points: raw, tangents, binormals };
}

function trackSample(track, t) {
  const pts = track.points;
  const n   = pts.length;
  const fi  = ((t % 1 + 1) % 1) * (n - 1);
  const i0  = Math.floor(fi) % n;
  const i1  = (i0 + 1) % n;
  const f   = fi - Math.floor(fi);
  return {
    pos: Vector3.Lerp(pts[i0], pts[i1], f),
    tan: Vector3.Lerp(track.tangents[i0],  track.tangents[i1],  f).normalize(),
    bi:  Vector3.Lerp(track.binormals[i0], track.binormals[i1], f).normalize(),
  };
}

// ═══════════════════════════════════════
//  ROAD
// ═══════════════════════════════════════
function buildRoad(track, scene) {
  const pts = track.points;
  const bis = track.binormals;
  const n   = pts.length;

  const leftPath  = [];
  const rightPath = [];
  for (let i = 0; i < n; i++) {
    leftPath.push( pts[i].add(bis[i].scale(-ROAD_W / 2)));
    rightPath.push(pts[i].add(bis[i].scale( ROAD_W / 2)));
  }

  const road = MeshBuilder.CreateRibbon("road", {
    pathArray: [leftPath, rightPath],
    closePath: true,
    sideOrientation: Mesh.DOUBLESIDE,
  }, scene);

  const mat = new PBRMaterial("roadMat", scene);
  mat.albedoColor   = new Color3(0.06, 0.06, 0.16);
  mat.metallic      = 0;
  mat.roughness     = 0.9;
  mat.emissiveColor = new Color3(0.02, 0.02, 0.06);
  road.material     = mat;

  // Rails as colored lines
  buildRailLine(leftPath,  scene, new Color3(0, 1, 1));
  buildRailLine(rightPath, scene, new Color3(1, 0, 1));

  // Center dashes
  const step = Math.max(1, Math.floor(n / 50));
  const dashPts = [];
  for (let i = 0; i < n; i += step) dashPts.push(pts[i]);
  dashPts.push(pts[0]);
  const dashes = MeshBuilder.CreateLines("dashes", { points: dashPts }, scene);
  dashes.color = new Color3(1, 1, 0);
  dashes.alpha = 0.35;
}

function buildRailLine(path, scene, col) {
  const closed = [...path, path[0]];
  // Subsample to keep line count low
  const step = Math.max(1, Math.floor(closed.length / 80));
  const sub  = closed.filter((_, i) => i % step === 0);
  sub.push(closed[0]);
  const line = MeshBuilder.CreateLines("rail", { points: sub }, scene);
  line.color = col;
  line.alpha  = 0.9;

  // Small glowing dots along rail
  const dotMat = new PBRMaterial("dotMat_" + Math.random(), scene);
  dotMat.albedoColor   = Color3.Black();
  dotMat.emissiveColor = col;
  dotMat.metallic      = 0;
  dotMat.roughness     = 1;
  const dotStep = Math.max(1, Math.floor(closed.length / 20));
  for (let i = 0; i < closed.length; i += dotStep) {
    const dot = MeshBuilder.CreateSphere("dot_" + i + Math.random(), { diameter: 0.55, segments: 4 }, scene);
    dot.position.copyFrom(closed[i]);
    dot.material = dotMat;
  }
}

// ═══════════════════════════════════════
//  CAR
// ═══════════════════════════════════════
function buildCar(scene, colorHex, idx) {
  const root = new TransformNode("car" + idx, scene);
  const col  = Color3.FromHexString("#" + colorHex.toString(16).padStart(6, "0"));

  const bodyMat = new PBRMaterial("bodyMat" + idx, scene);
  bodyMat.albedoColor    = col;
  bodyMat.metallic       = 0.7;
  bodyMat.roughness      = 0.2;
  bodyMat.emissiveColor  = col.scale(0.12);
  bodyMat.clearCoat.isEnabled  = true;
  bodyMat.clearCoat.intensity  = 0.9;
  bodyMat.clearCoat.roughness  = 0.1;

  const body = MeshBuilder.CreateBox("body" + idx, { width: 2.8, height: 0.58, depth: 5.0 }, scene);
  body.material = bodyMat; body.parent = root;

  const topMat = new PBRMaterial("topMat" + idx, scene);
  topMat.albedoColor = col.scale(0.65);
  topMat.metallic    = 0.5; topMat.roughness = 0.3;
  topMat.clearCoat.isEnabled = true; topMat.clearCoat.intensity = 0.6;
  const top = MeshBuilder.CreateBox("top" + idx, { width: 2.1, height: 0.62, depth: 2.1 }, scene);
  top.position.y = 0.6; top.position.z = 0.3;
  top.material = topMat; top.parent = root;

  const wingMat = new PBRMaterial("wingMat" + idx, scene);
  wingMat.albedoColor = new Color3(0.1, 0.1, 0.1);
  wingMat.metallic = 0.9; wingMat.roughness = 0.15;
  const wing = MeshBuilder.CreateBox("wing" + idx, { width: 3.1, height: 0.08, depth: 0.6 }, scene);
  wing.position.y = 0.95; wing.position.z = -2.3;
  wing.material = wingMat; wing.parent = root;

  // Headlights
  const hlMat = new PBRMaterial("hlMat" + idx, scene);
  hlMat.emissiveColor = new Color3(1, 1, 0.85);
  hlMat.albedoColor   = Color3.White();
  hlMat.metallic = 0; hlMat.roughness = 1;
  for (const s of [-1, 1]) {
    const hl = MeshBuilder.CreateBox("hl" + idx + s, { width: 0.48, height: 0.2, depth: 0.1 }, scene);
    hl.position.set(s * 1.0, 0.05, 2.55);
    hl.material = hlMat; hl.parent = root;
  }

  // Taillights
  const tlMat = new PBRMaterial("tlMat" + idx, scene);
  tlMat.emissiveColor = new Color3(1, 0.04, 0.04);
  tlMat.albedoColor   = Color3.Black();
  tlMat.metallic = 0; tlMat.roughness = 1;
  for (const s of [-1, 1]) {
    const tl = MeshBuilder.CreateBox("tl" + idx + s, { width: 0.48, height: 0.18, depth: 0.1 }, scene);
    tl.position.set(s * 1.0, 0.05, -2.55);
    tl.material = tlMat; tl.parent = root;
  }

  // Wheels
  const tyreMat = new PBRMaterial("tyre" + idx, scene);
  tyreMat.albedoColor = new Color3(0.07, 0.07, 0.07);
  tyreMat.metallic = 0; tyreMat.roughness = 0.95;
  const rimMat = new PBRMaterial("rim" + idx, scene);
  rimMat.albedoColor = new Color3(0.8, 0.8, 0.8);
  rimMat.metallic = 0.95; rimMat.roughness = 0.1;

  for (const [wx, wz] of [[-1.55, 1.9], [-1.55, -1.9], [1.55, 1.9], [1.55, -1.9]]) {
    const t = MeshBuilder.CreateCylinder("t_" + idx + wx + wz, { diameter: 1.08, height: 0.38, tessellation: 12 }, scene);
    t.rotation.z = Math.PI / 2; t.position.set(wx, -0.2, wz);
    t.material = tyreMat; t.parent = root;
    const r = MeshBuilder.CreateCylinder("r_" + idx + wx + wz, { diameter: 0.66, height: 0.4, tessellation: 8 }, scene);
    r.rotation.z = Math.PI / 2; r.position.set(wx, -0.2, wz);
    r.material = rimMat; r.parent = root;
  }

  return root;
}

// ═══════════════════════════════════════
//  PLACE CAR ON TRACK
// ═══════════════════════════════════════
function placeOnTrack(root, track, t, lat) {
  const s   = trackSample(track, t);
  const pos = s.pos.add(s.bi.scale(lat * ROAD_W * 0.62)).addInPlace(new Vector3(0, CAR_H, 0));
  root.position.copyFrom(pos);

  // Orientation: forward = track tangent, up = world up
  const fwd   = s.tan.clone();
  let   right = Vector3.Cross(UP, fwd);
  if (right.length() < 0.01) right = new Vector3(1, 0, 0);
  right.normalize();
  const up2 = Vector3.Cross(fwd, right).normalize();

  const m = Matrix.FromValues(
    right.x, right.y, right.z, 0,
    up2.x,   up2.y,   up2.z,   0,
    fwd.x,   fwd.y,   fwd.z,   0,
    0, 0, 0, 1
  );
  root.rotationQuaternion = Quaternion.FromRotationMatrix(m);
}

// ═══════════════════════════════════════
//  PARTICLES
// ═══════════════════════════════════════
const MAX_PAR = 120;

function buildParPool(scene) {
  const pool = [];
  const sharedMat = new StandardMaterial("parMat", scene);
  sharedMat.disableLighting = true;
  sharedMat.emissiveColor   = Color3.White();

  for (let i = 0; i < MAX_PAR; i++) {
    const m = MeshBuilder.CreateSphere("p" + i, { diameter: 0.35, segments: 2 }, scene);
    m.material  = sharedMat.clone();
    m.isVisible = false;
    m.isPickable = false;
    pool.push({ mesh: m, active: false, vel: new Vector3(), life: 0, maxLife: 1 });
  }
  return pool;
}

function spawnPar(pool, pos, count, vel, col, life = 0.6) {
  let spawned = 0;
  for (const p of pool) {
    if (p.active || spawned >= count) continue;
    p.mesh.isVisible = true;
    p.mesh.position.copyFrom(pos);
    p.mesh.material.emissiveColor = col;
    p.vel.set(vel.x + (Math.random()-0.5)*5, vel.y + Math.random()*3, vel.z + (Math.random()-0.5)*5);
    p.life = p.maxLife = life;
    p.active = true;
    spawned++;
  }
}

function tickPar(pool, dt) {
  for (const p of pool) {
    if (!p.active) continue;
    p.life -= dt;
    if (p.life <= 0) { p.active = false; p.mesh.isVisible = false; continue; }
    p.mesh.position.addInPlace(p.vel.scale(dt));
    p.vel.y -= 9.8 * dt;
    const r = p.life / p.maxLife;
    p.mesh.scaling.setAll(r * 0.8 + 0.1);
    p.mesh.material.alpha = r;
  }
}

// ═══════════════════════════════════════
//  MINIMAP
// ═══════════════════════════════════════
const mmCanvas = document.getElementById("minimapCanvas");
const mmCtx    = mmCanvas.getContext("2d");
const MM = 120;
let mmPts = null;

function buildMinimap(track) {
  const pts = track.points;
  let x0=Infinity, x1=-Infinity, z0=Infinity, z1=-Infinity;
  for (const p of pts) {
    if (p.x<x0) x0=p.x; if (p.x>x1) x1=p.x;
    if (p.z<z0) z0=p.z; if (p.z>z1) z1=p.z;
  }
  const sc = Math.max(x1-x0, z1-z0), pd = 10;
  mmPts = pts.map(p => ({
    x: pd + ((p.x-x0)/sc)*(MM-pd*2),
    y: pd + ((p.z-z0)/sc)*(MM-pd*2),
  }));
}

function mmSample(t) {
  if (!mmPts) return { x: MM/2, y: MM/2 };
  const n  = mmPts.length - 1;
  const fi = ((t%1+1)%1) * n;
  const i0 = Math.floor(fi)%n, i1=(i0+1)%n, f=fi-Math.floor(fi);
  return { x: mmPts[i0].x*(1-f)+mmPts[i1].x*f, y: mmPts[i0].y*(1-f)+mmPts[i1].y*f };
}

function drawMinimap(cars) {
  if (!mmPts) return;
  mmCtx.clearRect(0, 0, MM, MM);
  mmCtx.beginPath(); mmCtx.strokeStyle="#0ff4"; mmCtx.lineWidth=2;
  mmCtx.moveTo(mmPts[0].x, mmPts[0].y);
  for (const p of mmPts) mmCtx.lineTo(p.x, p.y);
  mmCtx.closePath(); mmCtx.stroke();
  const cols = ["#fff","#f44","#2f8","#fa0"];
  for (let i=0; i<cars.length; i++) {
    const d = mmSample(cars[i].userData.t);
    mmCtx.beginPath(); mmCtx.arc(d.x, d.y, i===0?5:3.5, 0, Math.PI*2);
    mmCtx.fillStyle = cols[i]; mmCtx.fill();
  }
}

// ═══════════════════════════════════════
//  SUFFIX
// ═══════════════════════════════════════
function suffix(n) { return n===1?"ST":n===2?"ND":n===3?"RD":"TH"; }

// ═══════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════
async function main() {
  try {
    setProgress(5, "STARTING ENGINE...");

    const canvas = document.getElementById("gameCanvas");
    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      limitDeviceRatio: Math.min(window.devicePixelRatio, 2),
    });

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.01, 0.01, 0.04, 1);
    scene.fogMode    = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.003;
    scene.fogColor   = new Color3(0.01, 0.01, 0.08);

    setProgress(12, "LIGHTING UP...");
    await nextFrame();

    const amb = new HemisphericLight("amb", new Vector3(0,1,0), scene);
    amb.intensity   = 0.4;
    amb.diffuse     = new Color3(0.3, 0.3, 0.6);
    amb.groundColor = new Color3(0.05, 0.05, 0.12);

    const sun = new DirectionalLight("sun", new Vector3(-0.4,-1,-0.3), scene);
    sun.intensity = 0.7;

    const glow = new GlowLayer("glow", scene);
    glow.intensity      = 1.4;
    glow.blurKernelSize = 32;

    // Skybox
    const sky = MeshBuilder.CreateSphere("sky", { diameter: 1600, sideOrientation: Mesh.BACKSIDE }, scene);
    const skyMat = new StandardMaterial("skyMat", scene);
    skyMat.emissiveColor   = new Color3(0.01, 0.01, 0.06);
    skyMat.disableLighting = true;
    skyMat.backFaceCulling = false;
    sky.material  = skyMat;
    sky.isPickable = false;

    setProgress(25, "BUILDING TRACK...");
    await nextFrame();

    const track = computeTrack();
    buildRoad(track, scene);
    buildMinimap(track);

    setProgress(50, "SPAWNING CARS...");
    await nextFrame();

    const carMeshes = [];
    for (let i = 0; i < 1 + NUM_AI; i++) {
      const mesh = buildCar(scene, CAR_COLORS[i], i);
      mesh.userData = {
        t: -i * 0.012, lat: (i%2===0?-1:1)*0.22, speed: BASE_SPEED,
        steer: 0, lap: 0, lapProgress: 0, totalDist: 0,
        falling: false, fallTimer: 0,
        ai: i > 0, isPlayer: i === 0,
        powerup: null, powerupTimer: 0,
        shield: false, ice: false, iceTimer: 0,
        stunTimer: 0, color: CAR_COLORS[i],
        aiTargetLat: 0, aiNextLane: 0,
      };
      placeOnTrack(mesh, track, mesh.userData.t, mesh.userData.lat);
      carMeshes.push(mesh);
    }
    const player = carMeshes[0];

    setProgress(65, "PLACING PICKUPS...");
    await nextFrame();

    // Pickups
    const pickups = [];
    {
      const dotMats = {};
      for (let i = 0; i < 10; i++) {
        const type    = POWERUP_TYPES[i % POWERUP_TYPES.length];
        const col     = Color3.FromHexString(POWERUP_COLS[type]);
        const box     = MeshBuilder.CreateBox("pu_"+i, { size: 2.0 }, scene);
        const mat     = new PBRMaterial("puMat_"+i, scene);
        mat.albedoColor   = Color3.Black();
        mat.emissiveColor = col;
        mat.metallic = 0; mat.roughness = 1;
        box.material  = mat;
        const t = i / 10;
        const s = trackSample(track, t);
        box.position.copyFrom(s.pos.add(new Vector3(0, CAR_H+1.5, 0)));
        pickups.push({ mesh: box, mat, t, type, active: true, respawn: 0 });
      }
    }

    setProgress(80, "BUILDING PARTICLES...");
    await nextFrame();

    const parPool = buildParPool(scene);

    setProgress(90, "SETTING UP CAMERA...");
    await nextFrame();

    const camera = new UniversalCamera("cam", new Vector3(0, 10, -20), scene);
    camera.minZ = 0.5;
    camera.maxZ = 2000;
    camera.setTarget(Vector3.Zero());

    const camPos  = player.position.clone().add(new Vector3(0, 6, -14));
    const camLook = player.position.clone();

    // Input
    const keys = {};
    window.addEventListener("keydown", e => { keys[e.code] = true; });
    window.addEventListener("keyup",   e => { keys[e.code] = false; });

    let touchLeft=false, touchRight=false, touchUse=false;
    const tlBtn=document.getElementById("touch-left");
    const trBtn=document.getElementById("touch-right");
    const tuBtn=document.getElementById("touch-use");
    const addTouch = (el, set) => {
      el.addEventListener("touchstart", e => { e.preventDefault(); set(true);  el.classList.add("pressed");    }, { passive:false });
      el.addEventListener("touchend",   e => { e.preventDefault(); set(false); el.classList.remove("pressed"); }, { passive:false });
    };
    addTouch(tlBtn, v => touchLeft  = v);
    addTouch(trBtn, v => touchRight = v);
    addTouch(tuBtn, v => touchUse   = v);

    let gyroY = 0;
    window.addEventListener("deviceorientation", e => {
      if (e.gamma !== null) gyroY = Math.max(-45, Math.min(45, e.gamma)) / 45;
    });

    // HUD refs
    const posNum   = document.getElementById("pos-num");
    const posSuf   = document.getElementById("pos-suffix");
    const lapNum   = document.getElementById("lap-num");
    const speedNum = document.getElementById("speed-num");
    const puDisp   = document.getElementById("powerup-display");
    const puIcon   = document.getElementById("powerup-icon");
    const puName   = document.getElementById("powerup-name");

    function updatePuHUD(type) {
      if (!type) { puDisp.classList.add("hidden"); return; }
      puDisp.classList.remove("hidden");
      puIcon.textContent = POWERUP_ICONS[type] || "?";
      puName.textContent = type;
    }

    // Engine oscillator
    let engOsc = null, engGain = null;
    try {
      const ctx = getAudio();
      engOsc  = ctx.createOscillator();
      engGain = ctx.createGain();
      engOsc.connect(engGain); engGain.connect(ctx.destination);
      engOsc.type = "sawtooth"; engOsc.frequency.value = 80;
      engGain.gain.value = 0.04;
      engOsc.start();
    } catch {}

    // Game state
    let raceStarted  = false;
    let raceFinished = false;
    let raceTime     = 0;
    let finishCount  = 0;
    let usePuFlag    = false;

    // Show UI
    setProgress(100, "GO!");
    loadingEl.classList.add("fade-out");
    setTimeout(() => { loadingEl.style.display = "none"; }, 700);
    hudEl.classList.remove("hidden");
    countdownEl.classList.remove("hidden");

    // Countdown
    (async () => {
      for (let c = 3; c >= 1; c--) {
        countdownEl.textContent = c;
        countdownEl.style.animation = "none";
        void countdownEl.offsetWidth;
        countdownEl.style.animation = "countPop 0.6s ease-out";
        playTone(440, "square", 0.2, 0.3);
        await sleep(900);
      }
      countdownEl.textContent = "GO!";
      countdownEl.style.color = "#0f0";
      countdownEl.style.animation = "none";
      void countdownEl.offsetWidth;
      countdownEl.style.animation = "countPop 0.6s ease-out";
      playTone(880, "sawtooth", 0.35, 0.4);
      raceStarted = true;
      await sleep(700);
      countdownEl.classList.add("hidden");
    })();

    // ── Render loop ──
    let lastT = performance.now();
    const tmpV = new Vector3();

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
          const s = trackSample(track, pu.t);
          pu.mesh.position.y = s.pos.y + CAR_H + 1.5 + Math.sin(raceTime*2.5 + pu.t*40)*0.4;
        } else if (pu.respawn > 0) {
          pu.respawn -= dt;
          if (pu.respawn <= 0) {
            pu.active = true; pu.mesh.isVisible = true;
            pu.type = POWERUP_TYPES[Math.floor(Math.random()*POWERUP_TYPES.length)];
            pu.mat.emissiveColor = Color3.FromHexString(POWERUP_COLS[pu.type]);
          }
        }
      }

      // Cars
      for (let ci = 0; ci < carMeshes.length; ci++) {
        const car = carMeshes[ci];
        const d   = car.userData;

        if (d.stunTimer > 0) { d.stunTimer -= dt; d.speed *= 0.92; placeOnTrack(car, track, d.t, d.lat); continue; }

        const topSpd = d.powerup==="TURBO" ? MAX_SPEED*1.35 : d.powerup==="ROCKET" ? MAX_SPEED*1.6 : MAX_SPEED;

        if (d.ai) {
          d.speed = Math.min(d.speed + ACCEL*dt*(0.82+ci*0.06), topSpd*0.93);
        } else {
          if (keys["ArrowUp"]||keys["KeyW"])        d.speed = Math.min(d.speed + ACCEL*dt, topSpd);
          else if (keys["ArrowDown"]||keys["KeyS"]) d.speed = Math.max(d.speed - BRAKE*dt, 4);
          else                                       d.speed = Math.max(d.speed - 1.5*dt, BASE_SPEED);
          d.speed = Math.min(d.speed, topSpd);
        }

        let steerIn = 0;
        if (d.ai) {
          if (!d.aiNextLane || raceTime > d.aiNextLane) {
            d.aiTargetLat = (Math.random()-0.5)*0.9;
            d.aiNextLane  = raceTime + 1.5 + Math.random()*2;
          }
          steerIn = Math.max(-1, Math.min(1, (d.aiTargetLat - d.lat)*2.5));
        } else {
          if (keys["ArrowLeft"] ||keys["KeyA"]||touchLeft)  steerIn -= 1;
          if (keys["ArrowRight"]||keys["KeyD"]||touchRight) steerIn += 1;
          if (Math.abs(gyroY) > 0.08) steerIn += gyroY;
          steerIn = Math.max(-1, Math.min(1, steerIn));
          // Powerup
          if ((keys["Space"]||keys["KeyE"]||touchUse) && !usePuFlag) {
            usePuFlag = true;
            activatePowerup(d, carMeshes, parPool, player, track);
          }
          if (!keys["Space"]&&!keys["KeyE"]&&!touchUse) usePuFlag = false;
        }
        if (d.ice) steerIn *= 0.3;

        d.steer += (steerIn - d.steer) * (1 - Math.pow(STEER_DAMP, dt*60));

        const tAdv = (d.speed * dt) / (track.points.length * 2.2);
        d.t   += tAdv;
        d.lat += d.steer * STEER_RATE * dt;
        d.lat  = Math.max(-1.3, Math.min(1.3, d.lat));

        if (d.t > 0.5) d.lapProgress = 1;
        if (d.t >= 1 && d.lapProgress > 0.5) {
          d.t -= 1; d.lap++; d.lapProgress = 0;
          if (!d.ai) {
            lapNum.textContent = Math.min(d.lap+1, LAPS);
            playTone(660, "square", 0.25, 0.35);
            spawnPar(parPool, car.position, 20, new Vector3(0,3,0), new Color3(0,1,1), 0.7);
          }
          if (d.lap >= LAPS) {
            finishCount++;
            if (d.isPlayer) { raceFinished = true; showEnd(finishCount, raceTime); }
            d.speed = BASE_SPEED * 0.5;
          }
        }

        // Fall
        if (Math.abs(d.lat) > FALL_LAT) {
          d.fallTimer += dt;
          if (d.fallTimer > 0.3) {
            spawnPar(parPool, car.position, 25, new Vector3(0,2,0), new Color3(1,0.3,0), 0.9);
            d.lat = 0; d.t = ((d.t%1)+1)%1 - 0.02;
            d.speed = BASE_SPEED * 0.65; d.fallTimer = 0;
            if (!d.ai) playTone(200, "sawtooth", 0.5, 0.3);
          }
        } else { d.fallTimer = 0; }

        placeOnTrack(car, track, d.t, d.lat);

        // Powerup tick
        if (d.powerup && d.powerupTimer > 0) {
          d.powerupTimer -= dt;
          if (d.powerupTimer <= 0) { d.powerup=null; d.shield=false; d.ice=false; if(!d.ai) updatePuHUD(null); }
        }
        if (d.ice) { d.iceTimer -= dt; if (d.iceTimer<=0) d.ice=false; }

        // Pickups
        for (const pu of pickups) {
          if (!pu.active) continue;
          const s   = trackSample(track, pu.t);
          const pup = s.pos.add(new Vector3(0, CAR_H+1.5, 0));
          if (Vector3.Distance(car.position, pup) < 4.5) {
            pu.active = false; pu.mesh.isVisible = false; pu.respawn = 8 + Math.random()*5;
            if (!d.ai) { d.powerup = pu.type; d.powerupTimer = 12; updatePuHUD(pu.type); playTone(550,"square",0.2,0.3); }
            else { applyAIPickup(pu.type, d, carMeshes, parPool, player); }
          }
        }
      }

      // AI ramming
      for (let i=1; i<carMeshes.length; i++) {
        const dist = Vector3.Distance(carMeshes[i].position, player.position);
        if (dist < 5.5 && !player.userData.shield) {
          const push = player.position.subtract(carMeshes[i].position).normalize();
          player.userData.lat   += push.x * 0.22;
          player.userData.speed *= 0.9;
        }
      }

      // HUD
      const sorted = [...carMeshes].sort((a,b)=>{
        const at = a.userData.lap + ((a.userData.t%1+1)%1);
        const bt = b.userData.lap + ((b.userData.t%1+1)%1);
        return bt - at;
      });
      const pos = sorted.indexOf(player) + 1;
      posNum.textContent = pos; posSuf.textContent = suffix(pos);
      lapNum.textContent = Math.min(player.userData.lap+1, LAPS);
      speedNum.textContent = Math.round(player.userData.speed * 3.6 * 0.5);

      if (engOsc) {
        const freq = 60 + (player.userData.speed / MAX_SPEED) * 210;
        try { engOsc.frequency.setTargetAtTime(freq, getAudio().currentTime, 0.1); } catch {}
      }

      // Camera
      const s    = trackSample(track, ((player.userData.t%1+1)%1));
      const flat = new Vector3(s.tan.x, s.tan.y*0.18, s.tan.z).normalize();
      const idealPos  = player.position.subtract(flat.scale(14)).add(new Vector3(0,6,0));
      const idealLook = player.position.add(flat.scale(12));
      const a = Math.min(dt*9, 1);
      Vector3.LerpToRef(camPos, idealPos,  a, camPos);
      Vector3.LerpToRef(camLook, idealLook, Math.min(dt*11,1), camLook);
      camera.position.copyFrom(camPos);
      camera.setTarget(camLook);
      camera.upVector.set(0,1,0);

      // Particles
      tickPar(parPool, dt);

      // Exhaust
      if (Math.random() < 0.3) {
        const ex  = player.position.add(new Vector3(0,-0.2,-2.6));
        const spd = player.userData.speed;
        spawnPar(parPool, ex, 1,
          new Vector3((Math.random()-0.5)*2, 1, -spd*0.03),
          spd > BASE_SPEED*1.5 ? new Color3(0,0.7,1) : new Color3(0.5,0.5,0.5),
          0.28);
      }

      drawMinimap(carMeshes);
    });

    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    // ─────────────────────────────────────
    function activatePowerup(d, cars, pool, playerCar, track) {
      if (!d.powerup) return;
      const type = d.powerup;
      playTone(770, "square", 0.25, 0.4);

      if (type==="TURBO")  { d.speed = Math.min(d.speed+28, MAX_SPEED*1.35); spawnPar(pool, playerCar.position, 20, new Vector3(0,2,0), new Color3(0,1,1), 0.6); }
      if (type==="ROCKET") { d.speed = MAX_SPEED*1.6; d.powerupTimer = 4; spawnPar(pool, playerCar.position, 30, new Vector3(0,3,0), new Color3(1,0.4,0), 0.8); }
      if (type==="SHIELD") { d.shield = true; d.powerupTimer = 8; spawnPar(pool, playerCar.position, 15, new Vector3(0,2,0), new Color3(0,0.6,1), 0.6); }
      if (type==="MAGNET") { d.t += 0.025; d.speed = Math.min(d.speed+18, MAX_SPEED); spawnPar(pool, playerCar.position, 18, new Vector3(0,2,0), new Color3(1,0,1), 0.6); }
      if (type==="BOMB") {
        let nearest=null, best=Infinity;
        for (const c of cars) { if (c===playerCar) continue; const dist=Vector3.Distance(c.position, playerCar.position); if (dist<best){best=dist;nearest=c;} }
        if (nearest && best<40) { nearest.userData.stunTimer=2.2; spawnPar(pool, nearest.position, 35, new Vector3(0,5,0), new Color3(1,0.5,0), 1); playTone(150,"sawtooth",0.5,0.45); }
      }
      if (type==="ICE")       { for (const c of cars) { if (c===playerCar) continue; c.userData.ice=true; c.userData.iceTimer=3; spawnPar(pool, c.position, 15, new Vector3(0,2,0), new Color3(0.5,0.9,1), 0.7); } }
      if (type==="LIGHTNING") { for (const c of cars) { if (c===playerCar) continue; c.userData.stunTimer=1.5; spawnPar(pool, c.position, 15, new Vector3(0,3,0), new Color3(1,1,0), 0.5); } playTone(1000,"sawtooth",0.35,0.4); }

      d.powerup=null; d.powerupTimer=0; updatePuHUD(null);
    }

    function applyAIPickup(type, d, cars, pool, playerCar) {
      const dist = Vector3.Distance(d.isPlayer ? Vector3.Zero() : playerCar.position, playerCar.position);
      if (type==="BOMB"||type==="ICE"||type==="LIGHTNING") {
        if (Vector3.Distance(playerCar.position, playerCar.position) < 35 || true) {
          if (type==="BOMB")      { playerCar.userData.stunTimer=1.8; spawnPar(pool, playerCar.position, 30, new Vector3(0,5,0), new Color3(1,0.5,0),1); }
          if (type==="ICE")       { playerCar.userData.ice=true; playerCar.userData.iceTimer=3; }
          if (type==="LIGHTNING") { playerCar.userData.stunTimer=1.2; }
        }
      }
    }

    function showEnd(pos, time) {
      endEl.classList.remove("hidden");
      const m=Math.floor(time/60), s2=Math.floor(time%60), ms=Math.floor((time%1)*100);
      document.getElementById("end-position").textContent = pos===1?"1ST PLACE — WINNER!": pos+suffix(pos)+" PLACE";
      document.getElementById("end-time").textContent = `TIME: ${m}:${String(s2).padStart(2,"0")}.${String(ms).padStart(2,"0")}`;
      playTone(880,"square",0.1,0.4);
      setTimeout(()=>playTone(1100,"square",0.1,0.4),150);
      setTimeout(()=>playTone(1320,"square",0.3,0.4),300);
    }

    document.getElementById("restartBtn").addEventListener("click", () => window.location.reload());

  } catch (err) {
    console.error("WILD RIDE ERROR:", err);
    document.getElementById("loadingText").textContent = "ERROR: " + err.message;
    document.getElementById("loadingText").style.color = "#f44";
  }
}

main();
