import * as THREE from "three";
import { loadObservedDem, type DemStatus } from "./dem";
import { buildTerrainArrays, sampleFloor, sampleTerrain, type Field } from "./heightfield";
import { held, pilot, type FlightFlags, type FlightMeters } from "./input";
import { emptySky, loadObservedWeather, readSky, type Sky, type WeatherStatus } from "./weather";

const STEP = 1 / 60;
const CLEARANCE = 3.1;
const TURN_RATE = 1.25;
const MOUSE_SENS = 0.00215;
const MAX_AIRSPEED = 130;
const SKY_RADIUS = 52_000;

const CARDINALS = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function cardinalOf(deg: number) {
  const d = ((deg % 360) + 360) % 360;
  return CARDINALS[Math.round(d / 45) % 8]!;
}

function startWorld(
  canvas: HTMLCanvasElement,
  field: Field,
  live: Sky,
  onMeters: (m: FlightMeters) => void,
  onFlags: (f: FlightFlags) => void,
): () => void {
  pilot.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const arrays = buildTerrainArrays(field);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.25 : 1.7));

  const camera = new THREE.PerspectiveCamera(64, 1, 0.4, 160_000);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2("#f3d7b5", 0.000032);

  const hemi = new THREE.HemisphereLight("#9ec8ea", "#6a8a48", 0.62);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff1d6", 1.35);
  sun.position.set(0.45, 0.85, 0.28);
  scene.add(sun);
  const fill = new THREE.DirectionalLight("#f4efe4", 0.28);
  fill.position.set(-0.6, 0.4, -0.3);
  scene.add(fill);
  const ambient = new THREE.AmbientLight("#f0e2cc", 0.38);
  scene.add(ambient);

  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
  terrainGeo.setAttribute("normal", new THREE.BufferAttribute(arrays.normals, 3));
  terrainGeo.setAttribute("color", new THREE.BufferAttribute(arrays.colors, 3));
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  scene.add(terrain);

  const wireMat = new THREE.MeshBasicMaterial({
    color: "#1c241c",
    wireframe: true,
    transparent: true,
    opacity: 0.55,
  });
  wireMat.polygonOffset = true;
  wireMat.polygonOffsetFactor = -1;
  wireMat.polygonOffsetUnits = -1;
  const wire = new THREE.Mesh(terrainGeo, wireMat);
  wire.visible = false;
  scene.add(wire);

  const waterMat = new THREE.MeshLambertMaterial({
    color: "#2f7f88",
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(field.size * 1.15, field.size * 1.15), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = field.sea - 0.15;
  scene.add(water);

  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 28, 14);
  const skyColors = new Float32Array(skyGeo.attributes.position.count * 3);
  skyGeo.setAttribute("color", new THREE.BufferAttribute(skyColors, 3));
  const skyMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -2;
  scene.add(sky);

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(780, 16, 12),
    new THREE.MeshBasicMaterial({ color: "#ffe7bf", fog: false, toneMapped: false }),
  );
  sunMesh.renderOrder = -1;
  scene.add(sunMesh);

  const starPositions: number[] = [];
  for (let i = 0; i < 220; i++) {
    const theta = hashUnit(i, 4) * Math.PI * 2;
    const y = 0.15 + hashUnit(i, 5) * 0.8;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    starPositions.push(Math.cos(theta) * r * 46_000, y * 46_000, Math.sin(theta) * r * 46_000);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  const starMat = new THREE.PointsMaterial({
    color: "#f4efe4",
    size: 48,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  const { trunks, crowns, rocks, clouds, cloudBase } = scatter(field);

  scene.add(trunks);
  scene.add(crowns);
  scene.add(rocks);
  scene.add(clouds);

  const glider = buildGlider();
  scene.add(glider);
  const prop = glider.getObjectByName("prop") as THREE.Group;

  const spawn = { ...field.spawn, yaw: 0, pitch: -0.1 };

  let x = spawn.x;
  let y = spawn.y;
  let z = spawn.z;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let yaw = spawn.yaw;
  let pitch = spawn.pitch;
  let bank = 0;
  let speed = 0;
  let onGround = false;
  let flying = false;
  let wireOn = false;
  let nightTarget = 0;
  let nightMix = 0;
  let snapCam = false;
  let orbit = 0.85;
  let prevF = false;
  let prevN = false;
  let flagKey = "";

  const dayZenith = new THREE.Color("#6eadd4");
  const nightZenith = new THREE.Color("#070b18");
  const dayHorizon = new THREE.Color("#f3d7b5");
  const nightHorizon = new THREE.Color("#1a2744");
  const zenith = new THREE.Color();
  const horizon = new THREE.Color();
  const sunDir = new THREE.Vector3();
  const daySun = new THREE.Vector3(0.42, 0.84, 0.26).normalize();
  const nightSun = new THREE.Vector3(-0.38, 0.62, -0.42).normalize();
  const look = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const dayHemi = new THREE.Color("#9ec8ea");
  const overcast = new THREE.Color("#c9d3d4");
  let nightTouched = false;
  let weatherPainted = false;

  function paintSky(t: number) {
    zenith.copy(dayZenith).lerp(nightZenith, t);
    horizon.copy(dayHorizon).lerp(nightHorizon, t);
    if (live.ready) horizon.lerp(overcast, live.cloud * live.blend * 0.45);
    const pos = skyGeo.attributes.position;
    const col = skyGeo.attributes.color as THREE.BufferAttribute;
    const radius = SKY_RADIUS;
    for (let i = 0; i < pos.count; i++) {
      const yy = pos.getY(i) / radius;
      const k = THREE.MathUtils.smoothstep(yy, -0.08, 0.72);
      col.setXYZ(
        i,
        horizon.r + (zenith.r - horizon.r) * k,
        horizon.g + (zenith.g - horizon.g) * k,
        horizon.b + (zenith.b - horizon.b) * k,
      );
    }
    col.needsUpdate = true;
    const vis = live.ready ? Math.max(5000, live.visibilityM) : 50_000;
    const fromVis = Math.min(0.00005, 0.85 / vis);
    const density =
      THREE.MathUtils.lerp(0.000032, Math.max(0.000032, fromVis), live.ready ? live.blend : 0) +
      live.cloud * live.blend * 0.000012 +
      (live.precipMm > 0.2 ? 0.000012 * live.blend : 0);
    scene.fog = new THREE.FogExp2(horizon.getHex(), THREE.MathUtils.lerp(density, density * 1.12, t));
    scene.background = horizon;
    hemi.color.copy(dayHemi).lerp(zenith, t);
    hemi.groundColor.set(t > 0.5 ? "#1c2420" : "#6a8a48");
    hemi.intensity = THREE.MathUtils.lerp(0.62, 0.42, t);
    sun.color.set(t > 0.5 ? "#d5defa" : "#fff1d6");
    sun.intensity = THREE.MathUtils.lerp(1.35, 0.72, t);
    fill.intensity = THREE.MathUtils.lerp(0.3, 0.22, t);
    ambient.color.set(t > 0.5 ? "#9aacc8" : "#f0e2cc");
    ambient.intensity = THREE.MathUtils.lerp(0.38, 0.46, t);
    waterMat.color.set(t > 0.5 ? "#16343f" : "#2c7c86");
    (sunMesh.material as THREE.MeshBasicMaterial).color.set(t > 0.5 ? "#d5defa" : "#ffe6b8");
    sunMesh.scale.setScalar(THREE.MathUtils.lerp(1, 0.55, t));
    wireMat.color.set(t > 0.5 ? "#d7e0d4" : "#1c241c");
    starMat.opacity = t;
    clouds.material.color.set(t > 0.5 ? "#8e9bb4" : "#f7f4ee");
  }

  // Cloud material typed loosely via the mesh we created.
  paintSky(0);

  function emitFlags(locked: boolean) {
    const key = `${wireOn}|${nightTarget}|${onGround}|${locked}`;
    if (key === flagKey) return;
    flagKey = key;
    onFlags({ wire: wireOn, night: nightTarget > 0.5, onGround, locked });
  }

  function toggleWire() {
    wireOn = !wireOn;
    wire.visible = wireOn;
    emitFlags(document.pointerLockElement === canvas);
  }

  function applyNight(night: boolean) {
    nightTarget = night ? 1 : 0;
    if (pilot.reducedMotion) {
      nightMix = nightTarget;
      paintSky(nightMix);
    }
    emitFlags(document.pointerLockElement === canvas);
  }

  function setNight(night: boolean) {
    nightTouched = true;
    applyNight(night);
  }

  function begin() {
    if (flying) return;
    flying = true;
    pilot.running = true;
    pilot.mouseX = 0;
    pilot.mouseY = 0;
    vx = 0;
    vy = 0;
    vz = 0;
    x = spawn.x;
    y = spawn.y;
    z = spawn.z;
    yaw = spawn.yaw;
    pitch = spawn.pitch;
    bank = 0;
    snapCam = true;
    try {
      if (window.matchMedia("(pointer: fine)").matches) canvas.requestPointerLock();
    } catch {
      /* iframe or denied — drag-look still works */
    }
  }

  window.__kammflug = { start: begin, toggleWire, setNight };
  window.__controlsTest = {
    getYaw: () => yaw,
    getSpeed: () => speed,
    setKeys: (codes) => {
      pilot.injected.clear();
      pilot.steerOverride = null;
      for (const code of codes) pilot.injected.add(code);
    },
    setSteer: (v) => {
      pilot.steerOverride = v;
    },
  };
  if (pilot.arm) begin();

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const onKeyDown = (e: KeyboardEvent) => {
    const block = [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "KeyQ",
      "KeyE",
      "KeyC",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Space",
    ];
    if (block.includes(e.code)) e.preventDefault();
    pilot.keys.add(e.code);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    pilot.keys.delete(e.code);
  };
  const clearKeys = () => {
    pilot.keys.clear();
    pilot.liftUp = false;
    pilot.liftDown = false;
  };

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (!flying) return;
    if (document.pointerLockElement === canvas) {
      pilot.mouseX += e.movementX;
      pilot.mouseY += e.movementY;
    }
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!flying || document.pointerLockElement === canvas) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || document.pointerLockElement === canvas) return;
    pilot.mouseX += e.clientX - lastX;
    pilot.mouseY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  };
  const onPointerUp = () => {
    dragging = false;
  };
  const onClick = () => {
    if (!flying) return;
    if (document.pointerLockElement !== canvas && window.matchMedia("(pointer: fine)").matches) {
      try {
        canvas.requestPointerLock();
      } catch {
        /* drag-look remains */
      }
    }
  };
  const onLockChange = () => {
    emitFlags(document.pointerLockElement === canvas);
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", clearKeys);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearKeys();
  });
  document.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("click", onClick);
  document.addEventListener("pointerlockchange", onLockChange);

  const timer = new THREE.Timer();
  timer.connect(document);
  let accum = 0;
  let simTime = 0;

  const rainCount = 140;
  const rainGeo = new THREE.BoxGeometry(0.12, 1, 0.12);
  const rainMat = new THREE.MeshBasicMaterial({
    color: "#c5dbe3",
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const rain = new THREE.InstancedMesh(rainGeo, rainMat, rainCount);
  rain.frustumCulled = false;
  rain.visible = false;
  scene.add(rain);
  const rainSeed = new Float32Array(rainCount * 4);
  for (let i = 0; i < rainCount; i++) {
    rainSeed[i * 4] = (hashUnit(i, 41) - 0.5) * 90;
    rainSeed[i * 4 + 1] = hashUnit(i, 42) * 50;
    rainSeed[i * 4 + 2] = (hashUnit(i, 43) - 0.5) * 90;
    rainSeed[i * 4 + 3] = 0.65 + hashUnit(i, 44) * 0.7;
  }

  function updateRain(px: number, py: number, pz: number, wet: boolean, snow: boolean, precip: number) {
    const show = live.ready && live.blend > 0.25 && (wet || snow || precip > 0.15);
    rain.visible = show;
    if (!show) return;
    rainMat.color.set(snow ? "#f4efe4" : "#c5dbe3");
    rainMat.opacity = Math.min(0.5, 0.18 + precip * 0.1);
    const reach = 48;
    const fall = (snow ? 9 : 26) * simTime;
    for (let i = 0; i < rainCount; i++) {
      const cycle = (rainSeed[i * 4 + 1]! - fall * rainSeed[i * 4 + 3]!) % reach;
      const yOff = cycle < 0 ? cycle + reach : cycle;
      const flake = snow ? 0.7 : 0.16;
      const len = snow ? 1.3 : 7;
      cloudDummy.position.set(px + rainSeed[i * 4]!, py + yOff - 8, pz + rainSeed[i * 4 + 2]!);
      cloudDummy.rotation.set(0, 0, 0);
      cloudDummy.scale.set(flake, len, flake);
      cloudDummy.updateMatrix();
      rain.setMatrixAt(i, cloudDummy.matrix);
    }
    rain.instanceMatrix.needsUpdate = true;
  }

  function step(dt: number) {
    simTime += dt;
    let steer = 0;
    if (held("KeyA") || held("ArrowLeft")) steer += 1;
    if (held("KeyD") || held("ArrowRight")) steer -= 1;
    steer -= pilot.stickX;
    if (pilot.steerOverride !== null) steer = pilot.steerOverride;
    steer = clamp(steer, -1, 1);

    let thrust = 0;
    if (held("KeyW")) thrust += 1;
    if (held("KeyS")) thrust -= 1;
    thrust += pilot.stickY;
    thrust = clamp(thrust, -1, 1);

    let lift = (pilot.liftUp ? 1 : 0) - (pilot.liftDown ? 1 : 0);
    if (held("Space")) lift += 1;
    if (held("ControlLeft") || held("ControlRight") || held("ShiftLeft") || held("KeyC")) lift -= 1;
    lift = clamp(lift, -1, 1);

    if (held("KeyQ") || held("ArrowUp")) pitch += 0.9 * dt;
    if (held("KeyE") || held("ArrowDown")) pitch -= 0.9 * dt;

    // A → +steer → +yaw: nose left from the chase camera. Do not negate.
    yaw += steer * TURN_RATE * dt;
    pitch = clamp(pitch, -1.05, 1.05);
    const targetBank = steer * 0.62;
    bank += (targetBank - bank) * (1 - Math.exp(-8 * dt));

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = sp;
    const fz = -Math.cos(yaw) * cp;

    const wind = readSky(live, x, z, simTime);
    const wx = onGround ? 0 : wind.x;
    const wz = onGround ? 0 : wind.z;
    let ax = vx - wx;
    let ay = vy;
    let az = vz - wz;

    const accel = 48;
    ax += fx * thrust * accel * dt;
    ay += fy * thrust * accel * dt;
    az += fz * thrust * accel * dt;
    ay += lift * 24 * dt;

    const drag = Math.exp(onGround ? -2.1 * dt : -0.34 * dt);
    ax *= drag;
    ay *= drag;
    az *= drag;

    const air = Math.hypot(ax, ay, az);
    if (air > MAX_AIRSPEED) {
      const scale = MAX_AIRSPEED / air;
      ax *= scale;
      ay *= scale;
      az *= scale;
    }

    vx = ax + wx;
    vy = ay;
    vz = az + wz;

    x += vx * dt;
    y += vy * dt;
    z += vz * dt;

    const hfx = -Math.sin(yaw);
    const hfz = -Math.cos(yaw);
    const floor = Math.max(
      sampleFloor(field, x, z),
      sampleFloor(field, x + hfx * 50, z + hfz * 50),
    );
    const limit = floor + CLEARANCE;
    onGround = false;
    if (y <= limit + 0.08) {
      if (y < limit) y = limit;
      if (vy < 0) vy = 0;
      onGround = true;
    }

    const lim = field.radiusM * 0.96;
    if (x > lim) {
      x = lim;
      if (vx > 0) vx = 0;
    } else if (x < -lim) {
      x = -lim;
      if (vx < 0) vx = 0;
    }
    if (z > lim) {
      z = lim;
      if (vz > 0) vz = 0;
    } else if (z < -lim) {
      z = -lim;
      if (vz < 0) vz = 0;
    }

    speed = Math.hypot(vx, vy, vz);
  }

  function frame(timestamp: number) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.1);

    const fDown = held("KeyF");
    if (fDown && !prevF && flying) toggleWire();
    prevF = fDown;
    const nDown = held("KeyN");
    if (nDown && !prevN && flying) setNight(nightTarget < 0.5);
    prevN = nDown;

    if (flying) {
      yaw -= pilot.mouseX * MOUSE_SENS;
      pitch -= pilot.mouseY * MOUSE_SENS;
      pilot.mouseX = 0;
      pilot.mouseY = 0;
      pitch = clamp(pitch, -1.05, 1.05);

      accum += dt;
      let guard = 0;
      while (accum >= STEP && guard < 5) {
        step(STEP);
        accum -= STEP;
        guard++;
      }
    }

    if (Math.abs(nightMix - nightTarget) > 0.001) {
      const k = pilot.reducedMotion ? 1 : 1 - Math.exp(-2.6 * dt);
      nightMix += (nightTarget - nightMix) * k;
      paintSky(nightMix);
    }

    const blendWas = live.blend;
    if (live.ready) live.blend = Math.min(1, live.blend + dt * 0.45);
    if (live.ready && (!weatherPainted || blendWas < 1)) {
      if (!weatherPainted) {
        weatherPainted = true;
        if (!live.isDay && !nightTouched) applyNight(true);
      }
      paintSky(nightMix);
    }

    sunDir.copy(daySun).lerp(nightSun, nightMix).normalize();
    sun.position.copy(sunDir);
    sky.position.copy(camera.position);
    stars.position.copy(camera.position);
    sunMesh.position.copy(camera.position).addScaledVector(sunDir, 30_000);

    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = sp;
    const fz = -Math.cos(yaw) * cp;
    glider.position.set(x, y, z);
    glider.up.set(0, 1, 0);
    glider.lookAt(x + fx, y + fy, z + fz);
    glider.rotateZ(bank);
    if (prop) {
      const spin = pilot.reducedMotion ? 0.6 : 4 + speed * 0.45;
      prop.rotation.z += spin * dt;
    }

    const coverRead = readSky(live, 0, 0, simTime);
    const cover = coverRead.cloud;
    const driftX = coverRead.x;
    const driftZ = coverRead.z;
    driftClouds(
      clouds,
      cloudBase,
      simTime,
      field.radiusM * 1.6,
      cover,
      driftX,
      driftZ,
      field.maxElev + 420,
    );
    const here = readSky(live, x, z, simTime);
    updateRain(x, y, z, here.wet, here.snow, here.precip);

    if (!flying) {
      orbit += dt * (pilot.reducedMotion ? 0 : 0.08);
      const orbitR = field.radiusM * 1.05;
      const orbitH = Math.max(3200, field.maxElev * 1.45);
      camera.position.set(Math.sin(orbit) * orbitR, orbitH, Math.cos(orbit) * orbitR);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, field.maxElev * 0.28, 0);
    } else {
      const hfx = -Math.sin(yaw);
      const hfz = -Math.cos(yaw);
      desired.set(x - hfx * 16, y + 4.6 + pitch * 1.4, z - hfz * 16);
      if (snapCam) {
        camera.position.copy(desired);
        snapCam = false;
      } else {
        const blend = 1 - Math.exp(-5.2 * dt);
        camera.position.lerp(desired, blend);
      }
      look.set(x + hfx * 8, y + 0.9 + fy * 5, z + hfz * 8);
      camera.up.set(0, 1, 0);
      camera.lookAt(look);
      camera.rotateZ(bank * 0.28);
      if (!pilot.reducedMotion) {
        const targetFov = 64 + Math.min(7, speed * 0.07);
        camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-2.5 * dt));
        camera.updateProjectionMatrix();
      }
    }

    const heading = (((-yaw * 180) / Math.PI) % 360 + 360) % 360;
    const floorHere = sampleFloor(field, x, z);
    onMeters({
      alt: y,
      agl: Math.max(0, y - floorHere),
      speed,
      heading,
      cardinal: cardinalOf(heading),
      onGround,
    });
    emitFlags(document.pointerLockElement === canvas);

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(frame);
  emitFlags(false);

  return () => {
    renderer.setAnimationLoop(null);
    timer.dispose();
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", clearKeys);
    document.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("click", onClick);
    document.removeEventListener("pointerlockchange", onLockChange);
    window.__flightReady = false;
    terrainGeo.dispose();
    terrainMat.dispose();
    wireMat.dispose();
    water.geometry.dispose();
    waterMat.dispose();
    skyGeo.dispose();
    skyMat.dispose();
    sunMesh.geometry.dispose();
    (sunMesh.material as THREE.Material).dispose();
    starGeo.dispose();
    starMat.dispose();
    trunks.geometry.dispose();
    (trunks.material as THREE.Material).dispose();
    crowns.geometry.dispose();
    (crowns.material as THREE.Material).dispose();
    rocks.geometry.dispose();
    (rocks.material as THREE.Material).dispose();
    clouds.geometry.dispose();
    clouds.material.dispose();
    rainGeo.dispose();
    rainMat.dispose();
    glider.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    renderer.dispose();
    renderer.forceContextLoss();
  };
}

export function mount(
  canvas: HTMLCanvasElement,
  onMeters: (m: FlightMeters) => void,
  onFlags: (f: FlightFlags) => void,
  onStatus: (status: DemStatus) => void,
  onWeather: (status: WeatherStatus) => void,
): () => void {
  const ac = new AbortController();
  let disposeWorld = () => {};
  let cancelled = false;
  const sky = emptySky();
  onStatus({ phase: "loading", done: 0, total: 0 });
  onWeather({ phase: "loading" });
  loadObservedWeather(sky, ac.signal)
    .then((status) => {
      if (!cancelled) onWeather(status);
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      onWeather({ phase: "error", message: "Wetter gerade nicht erreichbar" });
    });
  loadObservedDem((done, total) => {
    if (!cancelled) onStatus({ phase: "loading", done, total });
  }, ac.signal)
    .then((field) => {
      if (cancelled) return;
      onStatus({
        phase: "ready",
        tiles: field.tiles,
        maxElev: Math.round(field.maxElev),
        radiusKm: field.radiusM / 1000,
        source: field.source,
      });
      disposeWorld = startWorld(canvas, field, sky, onMeters, onFlags);
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "Höhenabruf fehlgeschlagen";
      onStatus({ phase: "error", message });
    });
  return () => {
    cancelled = true;
    ac.abort();
    disposeWorld();
  };
}

function hashUnit(i: number, salt: number) {
  let n = Math.imul(i + 1, 374761393 + salt * 19);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function scatter(field: Field) {
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1.3, 5);
  const crownGeo = new THREE.ConeGeometry(1.15, 2.4, 5);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const cloudGeo = new THREE.BoxGeometry(1, 0.62, 0.85);

  const trunkMat = new THREE.MeshLambertMaterial({ color: "#6b4a32", flatShading: true });
  const crownMat = new THREE.MeshLambertMaterial({ color: "#2f6b45", flatShading: true });
  const rockMat = new THREE.MeshLambertMaterial({ color: "#8a8174", flatShading: true });
  const cloudMat = new THREE.MeshLambertMaterial({ color: "#f7f4ee", flatShading: true });

  type Spot = { x: number; y: number; z: number; s: number; rot: number };
  const treeSpots: Spot[] = [];
  const rockSpots: Spot[] = [];
  const spawnX = field.spawn.x;
  const spawnZ = field.spawn.z;

  for (let i = 0; i < 5000 && (treeSpots.length < 420 || rockSpots.length < 90); i++) {
    const u = hashUnit(i, 11);
    const v = hashUnit(i, 12);
    const px = (u - 0.5) * field.size;
    const pz = (v - 0.5) * field.size;
    if (px * px + pz * pz > field.radiusM * field.radiusM) continue;
    const h = sampleTerrain(field, px, pz);
    const stride = 90;
    const slope =
      Math.abs(sampleTerrain(field, px + stride, pz) - h) +
      Math.abs(sampleTerrain(field, px, pz + stride) - h);
    const near = (px - spawnX) ** 2 + (pz - spawnZ) ** 2 < 140 * 140;
    if (near) continue;
    if (treeSpots.length < 420 && h > 30 && h < 820 && slope < 55) {
      treeSpots.push({
        x: px,
        y: h,
        z: pz,
        s: 5 + hashUnit(i, 13) * 6,
        rot: hashUnit(i, 14) * Math.PI * 2,
      });
    } else if (rockSpots.length < 90 && h > 650 && h < 1750 && slope < 180) {
      rockSpots.push({
        x: px,
        y: h,
        z: pz,
        s: 8 + hashUnit(i, 15) * 18,
        rot: hashUnit(i, 16) * Math.PI,
      });
    }
  }

  const dummy = new THREE.Object3D();
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, treeSpots.length));
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, Math.max(1, treeSpots.length));
  trunks.count = treeSpots.length;
  crowns.count = treeSpots.length;
  const crownColor = new THREE.Color();
  treeSpots.forEach((spot, i) => {
    dummy.position.set(spot.x, spot.y + 0.65 * spot.s, spot.z);
    dummy.rotation.set(0, spot.rot, 0);
    dummy.scale.setScalar(spot.s);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(spot.x, spot.y + 2.05 * spot.s, spot.z);
    dummy.scale.set(spot.s * (0.85 + (i % 3) * 0.08), spot.s * (0.9 + (i % 5) * 0.08), spot.s);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    crownColor.set(i % 2 === 0 ? "#2f6b45" : "#3f7a3a");
    crowns.setColorAt(i, crownColor);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;

  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, rockSpots.length));
  rocks.count = rockSpots.length;
  const rockColor = new THREE.Color();
  rockSpots.forEach((spot, i) => {
    dummy.position.set(spot.x, spot.y + 0.35 * spot.s, spot.z);
    dummy.rotation.set(spot.rot * 0.2, spot.rot, spot.rot * 0.4);
    dummy.scale.set(spot.s * 1.3, spot.s * 0.7, spot.s);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    rockColor.set(i % 3 === 0 ? "#6e655c" : "#8d8578");
    rocks.setColorAt(i, rockColor);
  });
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;

  const clusterCount = 6;
  const per = 6;
  const total = clusterCount * per;
  const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, total);
  const cloudBase = new Float32Array(total * 4);
  let ci = 0;
  for (let c = 0; c < clusterCount; c++) {
    const cx = (hashUnit(c, 21) - 0.5) * field.radiusM * 1.3;
    const cz = (hashUnit(c, 22) - 0.5) * field.radiusM * 1.3;
    const cy = 2300 + hashUnit(c, 23) * 700;
    for (let k = 0; k < per; k++) {
      const ox = (hashUnit(ci, 24) - 0.5) * 1800;
      const oy = (hashUnit(ci, 25) - 0.5) * 180;
      const oz = (hashUnit(ci, 26) - 0.5) * 1200;
      const s = 420 + hashUnit(ci, 27) * 680;
      cloudBase[ci * 4] = cx + ox;
      cloudBase[ci * 4 + 1] = cy + oy;
      cloudBase[ci * 4 + 2] = cz + oz;
      cloudBase[ci * 4 + 3] = s;
      ci++;
    }
  }
  driftClouds(clouds, cloudBase, 0, field.radiusM * 1.6);

  return { trunks, crowns, rocks, clouds, cloudBase };
}

function driftClouds(
  mesh: THREE.InstancedMesh,
  base: Float32Array,
  elapsed: number,
  span: number,
  cover = 0.35,
  windX = 0,
  windZ = 0,
  floorY = 2200,
) {
  const total = base.length / 4;
  const shown = Math.max(4, Math.round(total * (0.28 + cover * 0.72)));
  mesh.count = shown;
  const mat = mesh.material as THREE.MeshLambertMaterial;
  mat.transparent = true;
  mat.opacity = 0.28 + cover * 0.62;
  const bulk = 0.42 + cover * 0.95;
  for (let i = 0; i < shown; i++) {
    const bx = base[i * 4]!;
    const by = base[i * 4 + 1]!;
    const bz = base[i * 4 + 2]!;
    const s = base[i * 4 + 3]!;
    const y = Math.max(floorY, by - cover * 640);
    cloudDummy.position.set(wrapCoord(bx + windX * elapsed, span), y, wrapCoord(bz + windZ * elapsed, span));
    cloudDummy.rotation.set(0, 0, 0);
    cloudDummy.scale.set(s * bulk, s * (0.42 + cover * 0.28), s * 0.72 * bulk);
    cloudDummy.updateMatrix();
    mesh.setMatrixAt(i, cloudDummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function wrapCoord(v: number, span: number) {
  let d = v % span;
  if (d < 0) d += span;
  return d - span / 2;
}

const cloudDummy = new THREE.Object3D();

function buildGlider() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: "#f4efe4", flatShading: true });
  const wingMat = new THREE.MeshLambertMaterial({ color: "#e39b3a", flatShading: true });
  const inkMat = new THREE.MeshLambertMaterial({ color: "#1c2830", flatShading: true });
  const noseMat = new THREE.MeshLambertMaterial({ color: "#b86a22", flatShading: true });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.42, 3.5), bodyMat);
  group.add(body);

  const noseGeo = new THREE.ConeGeometry(0.28, 0.9, 5);
  noseGeo.rotateX(Math.PI / 2);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.z = 2.1;
  group.add(nose);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.08, 1.15), wingMat);
  wing.position.set(0, 0.05, 0.2);
  group.add(wing);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.06, 0.5), wingMat);
  tail.position.set(0, 0.12, -1.5);
  group.add(tail);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.55), inkMat);
  fin.position.set(0, 0.42, -1.5);
  group.add(fin);

  const canopy = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.72), inkMat);
  canopy.position.set(0, 0.3, 0.45);
  group.add(canopy);

  const prop = new THREE.Group();
  prop.name = "prop";
  const bladeMat = new THREE.MeshLambertMaterial({ color: "#243028", flatShading: true });
  const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.35, 0.06), bladeMat);
  const bladeB = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.12, 0.06), bladeMat);
  prop.add(bladeA);
  prop.add(bladeB);
  prop.position.z = 2.55;
  group.add(prop);

  return group;
}
