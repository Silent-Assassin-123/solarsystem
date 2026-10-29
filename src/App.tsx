import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  Play,
  Pause,
  RotateCcw,
  Plus,
  Compass,
  Sun,
  Sliders,
  FolderOpen,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  Sparkles,
  Download,
  Upload,
  Maximize2,
} from 'lucide-react';
import {
  PlanetData,
  SolarSystemConfig,
  SurfaceType,
  DEFAULT_SOLAR_SYSTEM,
  PRESET_SYSTEMS,
  calculateOrbitalPosition,
  calculateInstantaneousAngularSpeed,
  generateOrbitPoints,
  computePlanetTelemetry,
  createNewPlanet,
  validateSystemConfig,
} from './solarMath';

const STORAGE_KEY = 'helios_custom_solar_systems_v1';

// Detect software WebGL from GPU renderer string (never user agent)
const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return false;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

// Pre-allocated math scratch objects for zero-GC render loop
const _planetWorldPos = new THREE.Vector3();
const _desiredCamTarget = new THREE.Vector3();
const _targetDelta = new THREE.Vector3();
const _projVec = new THREE.Vector3();

/**
 * Generates procedural planetary albedo and bump textures using HTML5 2D Canvas.
 */
function createProceduralPlanetTextures(
  planet: PlanetData,
  maxAnisotropy: number
): { colorMap: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture } {
  const width = 512;
  const height = 256;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;

  const c1 = new THREE.Color(planet.color);
  const c2 = new THREE.Color(planet.secondaryColor);

  // Fill base gradient
  const baseGrad = ctx.createLinearGradient(0, 0, 0, height);
  baseGrad.addColorStop(0, `#${c2.getHexString()}`);
  baseGrad.addColorStop(0.25, `#${c1.getHexString()}`);
  baseGrad.addColorStop(0.5, `#${c2.getHexString()}`);
  baseGrad.addColorStop(0.75, `#${c1.getHexString()}`);
  baseGrad.addColorStop(1, `#${c2.getHexString()}`);
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, width, height);

  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  // Deterministic pseudo-random generator from planet id + colors
  let seed = 0;
  const seedStr = `${planet.id}-${planet.surfaceType}-${planet.color}-${planet.secondaryColor}`;
  for (let i = 0; i < seedStr.length; i++) {
    seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  if (planet.surfaceType === 'gas_giant' || planet.surfaceType === 'ice_giant') {
    // Banded atmospheric zonal jets and vortices
    const bandCount = planet.surfaceType === 'gas_giant' ? 28 : 16;
    for (let i = 0; i < bandCount; i++) {
      const y = (i / bandCount) * height;
      const h = (height / bandCount) * (0.6 + rand() * 1.1);
      const mix = rand();
      const bandColor = c1.clone().lerp(c2, mix);
      if (rand() > 0.65) bandColor.offsetHSL(0, 0, (rand() - 0.5) * 0.16);
      ctx.fillStyle = `#${bandColor.getHexString()}`;
      ctx.globalAlpha = 0.55 + rand() * 0.35;
      ctx.fillRect(0, y, width, h);

      bCtx.fillStyle = mix > 0.5 ? '#969696' : '#6b6b6b';
      bCtx.fillRect(0, y, width, h);
    }
    // Storm ovals (like Great Red Spot)
    const stormCount = planet.surfaceType === 'gas_giant' ? 5 : 2;
    for (let s = 0; s < stormCount; s++) {
      const sx = rand() * width;
      const sy = height * (0.25 + rand() * 0.5);
      const rx = 18 + rand() * 32;
      const ry = 8 + rand() * 14;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
      const stormCol = c2.clone().offsetHSL(0.03, 0.15, 0.12);
      ctx.fillStyle = `#${stormCol.getHexString()}`;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.restore();
    }
  } else if (planet.surfaceType === 'oceanic') {
    // Deep ocean base with continents and polar ice caps
    ctx.globalAlpha = 1;
    ctx.fillStyle = `#${c1.getHexString()}`;
    ctx.fillRect(0, 0, width, height);
    bCtx.fillStyle = '#404040';
    bCtx.fillRect(0, 0, width, height);

    // Continental landmasses
    const continentClusters = 22;
    for (let c = 0; c < continentClusters; c++) {
      const cx = rand() * width;
      const cy = height * (0.15 + rand() * 0.7);
      const subBlobs = 10 + Math.floor(rand() * 12);
      for (let b = 0; b < subBlobs; b++) {
        const bx = (cx + (rand() - 0.5) * 75 + width) % width;
        const by = Math.max(18, Math.min(height - 18, cy + (rand() - 0.5) * 45));
        const r = 10 + rand() * 24;
        const landCol = c2.clone().offsetHSL((rand() - 0.5) * 0.05, 0, (rand() - 0.5) * 0.12);
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = `#${landCol.getHexString()}`;
        ctx.globalAlpha = 0.88;
        ctx.fill();

        bCtx.beginPath();
        bCtx.arc(bx, by, r, 0, Math.PI * 2);
        bCtx.fillStyle = '#c8c8c8';
        bCtx.fill();
      }
    }

    // Polar ice caps
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, width, 16);
    ctx.fillRect(0, height - 16, width, 16);
  } else if (planet.surfaceType === 'volcanic') {
    // Dark basalt crust with glowing magma fissures
    ctx.globalAlpha = 1;
    ctx.fillStyle = `#${c1.getHexString()}`;
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < 45; i++) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 8 + rand() * 26;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `#${c2.clone().offsetHSL(0, 0, -0.15).getHexString()}`;
      ctx.globalAlpha = 0.5;
      ctx.fill();
    }

    // Lava rivers & calderas
    ctx.strokeStyle = `#${c2.getHexString()}`;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.9;
    for (let l = 0; l < 18; l++) {
      let lx = rand() * width;
      let ly = rand() * height;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      for (let s = 0; s < 6; s++) {
        lx += (rand() - 0.5) * 45;
        ly += (rand() - 0.5) * 30;
        ctx.lineTo(lx, ly);
      }
      ctx.stroke();
    }
  } else {
    // Terrestrial, desert, or crystalline cratered / ridged terrain
    for (let i = 0; i < 90; i++) {
      const x = rand() * width;
      const y = rand() * height;
      const r = 4 + rand() * 28;
      const patchColor = c1.clone().lerp(c2, rand());
      patchColor.offsetHSL(0, 0, (rand() - 0.5) * 0.14);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `#${patchColor.getHexString()}`;
      ctx.globalAlpha = 0.45 + rand() * 0.35;
      ctx.fill();

      // Crater rim in bump map
      bCtx.beginPath();
      bCtx.arc(x, y, r, 0, Math.PI * 2);
      bCtx.fillStyle = rand() > 0.5 ? '#555555' : '#a8a8a8';
      bCtx.strokeStyle = '#e0e0e0';
      bCtx.lineWidth = 2;
      bCtx.fill();
      bCtx.stroke();
    }
  }

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.colorSpace = THREE.SRGBColorSpace;
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.ClampToEdgeWrapping;
  colorMap.anisotropy = maxAnisotropy;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;
  bumpMap.anisotropy = maxAnisotropy;

  return { colorMap, bumpMap };
}

/**
 * Generates a concentric planetary ring texture with Cassini-style divisions.
 */
function createRingTexture(ringColorHex: string, maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;

  const baseCol = new THREE.Color(ringColorHex);
  for (let x = 0; x < size; x++) {
    const t = x / size; // 0 = inner edge, 1 = outer edge
    const edgeFade = Math.sin(t * Math.PI);
    // Create Cassini gap around t = 0.62
    const gap = Math.abs(t - 0.62) < 0.045 ? 0.08 : 1.0;
    const fineRipple = 0.65 + 0.35 * Math.sin(t * 75) * Math.cos(t * 33);
    const alpha = Math.max(0, Math.min(0.92, edgeFade * gap * fineRipple));

    const c = baseCol.clone().offsetHSL(0, 0, (fineRipple - 0.65) * 0.2);
    ctx.fillStyle = `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(
      c.b * 255
    )}, ${alpha.toFixed(3)})`;
    ctx.fillRect(x, 0, 1, 32);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

/**
 * Generates a procedural solar granulation texture for the central star.
 */
function createStarTexture(colorHex: string, coronaHex: string): THREE.CanvasTexture {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const c1 = new THREE.Color(colorHex);
  const c2 = new THREE.Color(coronaHex);

  ctx.fillStyle = `#${c1.getHexString()}`;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 220; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const r = 3 + Math.random() * 18;
    const col = c1.clone().lerp(c2, Math.random() * 0.75);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `#${col.getHexString()}`;
    ctx.globalAlpha = 0.45;
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface PlanetRuntimeNode {
  id: string;
  rootGroup: THREE.Group;
  tiltGroup: THREE.Group;
  surfaceMesh: THREE.Mesh;
  cloudMesh?: THREE.Mesh;
  atmosphereMesh?: THREE.Mesh;
  ringMesh?: THREE.Mesh;
  moonsGroup: THREE.Group;
  orbitLine: THREE.Line;
  perihelionMarker: THREE.Mesh;
  theta: number;
  textures: THREE.Texture[];
}

export default function App() {
  // Load custom saved configurations from localStorage
  const [savedConfigs, setSavedConfigs] = useState<SolarSystemConfig[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => validateSystemConfig(item)).filter(Boolean) as SolarSystemConfig[];
    } catch {
      return [];
    }
  });

  // Active solar system state
  const [systemConfig, setSystemConfig] = useState<SolarSystemConfig>(DEFAULT_SOLAR_SYSTEM);
  const [selectedBodyId, setSelectedBodyId] = useState<string | null>('earth');
  const [cameraMode, setCameraMode] = useState<'overview' | 'chase' | 'equatorial' | 'polar'>('overview');

  // Simulation transport & speed controls
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [timeScale, setTimeScale] = useState<number>(1.0);
  const [simYears, setSimYears] = useState<number>(2026.82);

  // Visual & Lighting toggles
  const [showOrbits, setShowOrbits] = useState<boolean>(true);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [showAsteroids, setShowAsteroids] = useState<boolean>(true);
  const [observatoryFillLight, setObservatoryFillLight] = useState<boolean>(false);

  // UI Drawer & Modal states
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(true);
  const [isAddPlanetOpen, setIsAddPlanetOpen] = useState<boolean>(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState<boolean>(false);

  // Add Planet Form state
  const [newPlanetName, setNewPlanetName] = useState<string>('Kepler-452b');
  const [newPlanetSurface, setNewPlanetSurface] = useState<SurfaceType>('oceanic');
  const [newPlanetRadius, setNewPlanetRadius] = useState<number>(1.65);
  const [newPlanetDistance, setNewPlanetDistance] = useState<number>(158);
  const [newPlanetEccentricity, setNewPlanetEccentricity] = useState<number>(0.06);
  const [newPlanetRings, setNewPlanetRings] = useState<boolean>(true);
  const [newPlanetMoons, setNewPlanetMoons] = useState<number>(2);

  // Save/Load Config Modal state
  const [saveNameInput, setSaveNameInput] = useState<string>('Custom Helios System');
  const [saveDescInput, setSaveDescInput] = useState<string>('Modified orbital parameters and custom worlds.');
  const [importJsonText, setImportJsonText] = useState<string>('');
  const [configFeedback, setConfigFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedJson, setCopiedJson] = useState<boolean>(false);

  // Projected 2D screen coordinates for planet labels (updated at ~12Hz to avoid React re-render stalls)
  const [labelPositions, setLabelPositions] = useState<
    Record<string, { x: number; y: number; visible: boolean }>
  >({});

  // Refs for bridging React state into the persistent Three.js loop without tearing down canvas
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const systemConfigRef = useRef<SolarSystemConfig>(systemConfig);
  const selectedBodyIdRef = useRef<string | null>(selectedBodyId);
  const cameraModeRef = useRef(cameraMode);
  const isPlayingRef = useRef<boolean>(isPlaying);
  const timeScaleRef = useRef<number>(timeScale);
  const showOrbitsRef = useRef<boolean>(showOrbits);
  const showLabelsRef = useRef<boolean>(showLabels);
  const showGridRef = useRef<boolean>(showGrid);
  const showAsteroidsRef = useRef<boolean>(showAsteroids);
  const observatoryFillLightRef = useRef<boolean>(observatoryFillLight);

  // Three.js scene graph refs for surgical updates
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    starGroup: THREE.Group;
    starLight: THREE.PointLight;
    hemiLight: THREE.HemisphereLight;
    gridHelper: THREE.PolarGridHelper;
    asteroidBelt: THREE.InstancedMesh;
    planetNodes: Map<string, PlanetRuntimeNode>;
    clickableMeshes: THREE.Object3D[];
    cameraTransitionActive: boolean;
    rebuildSystemScene: (cfg: SolarSystemConfig, preserveAngles?: boolean) => void;
    focusOnBody: (bodyId: string | null, mode?: 'overview' | 'chase' | 'equatorial' | 'polar') => void;
  } | null>(null);

  // Keep refs synchronized with React state
  useEffect(() => {
    systemConfigRef.current = systemConfig;
    if (sceneRef.current) {
      sceneRef.current.rebuildSystemScene(systemConfig, true);
    }
  }, [systemConfig]);

  useEffect(() => {
    selectedBodyIdRef.current = selectedBodyId;
  }, [selectedBodyId]);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    timeScaleRef.current = timeScale;
  }, [timeScale]);

  useEffect(() => {
    showOrbitsRef.current = showOrbits;
    if (sceneRef.current) {
      sceneRef.current.planetNodes.forEach((node) => {
        node.orbitLine.visible = showOrbits;
        node.perihelionMarker.visible = showOrbits;
      });
    }
  }, [showOrbits]);

  useEffect(() => {
    showLabelsRef.current = showLabels;
  }, [showLabels]);

  useEffect(() => {
    showGridRef.current = showGrid;
    if (sceneRef.current) {
      sceneRef.current.gridHelper.visible = showGrid;
    }
  }, [showGrid]);

  useEffect(() => {
    showAsteroidsRef.current = showAsteroids;
    if (sceneRef.current) {
      sceneRef.current.asteroidBelt.visible = showAsteroids;
    }
  }, [showAsteroids]);

  useEffect(() => {
    observatoryFillLightRef.current = observatoryFillLight;
    if (sceneRef.current) {
      sceneRef.current.hemiLight.intensity = observatoryFillLight ? 1.85 : 0.42;
    }
  }, [observatoryFillLight]);

  // Keyboard shortcuts (Space = Play/Pause, H = Collapse/Expand HUD, Escape = System Overview)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((prev) => !prev);
      } else if (e.key === 'h' || e.key === 'H') {
        setDockCollapsed((prev) => !prev);
      } else if (e.key === 'Escape') {
        handleSelectBody(null, 'overview');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Initialize persistent WebGLRenderer & Scene once on mount
  useEffect(() => {
    const mount = canvasMountRef.current;
    if (!mount) return;

    const width = mount.clientWidth || window.innerWidth;
    const height = mount.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070e);
    scene.fog = new THREE.FogExp2(0x05070e, 0.0012);

    const camera = new THREE.PerspectiveCamera(48, width / height, 0.2, 1800);
    camera.position.set(-14, 28, 66);

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    // Studio environment reflection map via RoomEnvironment + PMREMGenerator
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    // OrbitControls setup
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.06;
    controls.minDistance = 3.2;
    controls.maxDistance = 420;
    controls.maxPolarAngle = Math.PI * 0.92;
    controls.target.set(0, -10, 0);
    controls.update();

    let cameraTransitionActive = false;
    controls.addEventListener('start', () => {
      cameraTransitionActive = false;
    });

    // Lighting Rig:
    // 1. Primary Solar Omnidirectional PointLight at (0,0,0)
    const starLight = new THREE.PointLight(0xfff4d6, 3.8, 600, 0.35);
    starLight.position.set(0, 0, 0);
    if (!isSoftwareGl) {
      starLight.castShadow = true;
      starLight.shadow.mapSize.width = 1024;
      starLight.shadow.mapSize.height = 1024;
      starLight.shadow.bias = -0.0005;
    }
    scene.add(starLight);

    // 2. Cool Cosmic Hemisphere Fill Light (prevents pitch-black vacuum backsides)
    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x0f172a, 0.42);
    hemiLight.position.set(0, 120, 0);
    scene.add(hemiLight);

    // 3. Subtle Rim Directional Light for celestial edge separation
    const rimLight = new THREE.DirectionalLight(0x7dd3fc, 0.35);
    rimLight.position.set(-120, 90, -140);
    scene.add(rimLight);

    // Ecliptic Polar Coordinate Grid
    const gridHelper = new THREE.PolarGridHelper(180, 16, 10, 64, 0x1e293b, 0x0f172a);
    gridHelper.position.y = -0.05;
    const gridMat = gridHelper.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.55;
    gridMat.depthWrite = false;
    scene.add(gridHelper);

    // Multi-Spectral Deep Space Starfield (1,800 stars)
    const starGeo = new THREE.BufferGeometry();
    const starCount = 1800;
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const spectralPalette = [
      new THREE.Color('#93c5fd'), // O/B blue-white
      new THREE.Color('#f8fafc'), // A/F crisp white
      new THREE.Color('#fef08a'), // G yellow
      new THREE.Color('#fdba74'), // K orange
    ];
    for (let i = 0; i < starCount; i++) {
      const r = 320 + Math.random() * 550;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPositions[i * 3 + 2] = r * Math.cos(phi);

      const c = spectralPalette[i % spectralPalette.length];
      const brightness = 0.55 + Math.random() * 0.45;
      starColors[i * 3] = c.r * brightness;
      starColors[i * 3 + 1] = c.g * brightness;
      starColors[i * 3 + 2] = c.b * brightness;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    const starFieldMat = new THREE.PointsMaterial({
      size: 1.45,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      sizeAttenuation: true,
    });
    const starField = new THREE.Points(starGeo, starFieldMat);
    scene.add(starField);

    // Main Asteroid Belt (InstancedMesh with 260 rocky bodies between Mars and Jupiter)
    const asteroidCount = 260;
    const asteroidGeo = new THREE.DodecahedronGeometry(0.32, 1);
    const asteroidMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      roughness: 0.85,
      metalness: 0.18,
    });
    const asteroidBelt = new THREE.InstancedMesh(asteroidGeo, asteroidMat, asteroidCount);
    const dummy = new THREE.Object3D();
    const astColor = new THREE.Color();
    for (let i = 0; i < asteroidCount; i++) {
      const angle = (i / asteroidCount) * Math.PI * 2 + Math.random() * 0.2;
      const radius = 51 + (Math.random() - 0.5) * 9.5;
      const yOffset = (Math.random() - 0.5) * 3.2;
      dummy.position.set(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);
      dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      const s = 0.55 + Math.random() * 1.15;
      dummy.scale.set(s * 1.2, s * 0.8, s);
      dummy.updateMatrix();
      asteroidBelt.setMatrixAt(i, dummy.matrix);

      const shade = 0.45 + Math.random() * 0.35;
      astColor.setRGB(shade, shade * 0.95, shade * 0.9);
      asteroidBelt.setColorAt(i, astColor);
    }
    asteroidBelt.instanceMatrix.needsUpdate = true;
    if (asteroidBelt.instanceColor) asteroidBelt.instanceColor.needsUpdate = true;
    asteroidBelt.computeBoundingSphere();
    scene.add(asteroidBelt);

    // Central Star Composite Group (6 distinct parts: Photosphere, Chromosphere, Corona Halo, Equatorial Accretion Ring, and 2 Magnetic Prominence Loops)
    const starGroup = new THREE.Group();
    starGroup.name = 'star-root';
    scene.add(starGroup);

    // Shared geometries for planets and moons
    const sphereGeo = new THREE.SphereGeometry(1, 40, 32);
    const lowSphereGeo = new THREE.SphereGeometry(1, 16, 14);
    const nodeMarkerGeo = new THREE.OctahedronGeometry(0.42, 0);

    const planetNodes = new Map<string, PlanetRuntimeNode>();
    let clickableMeshes: THREE.Object3D[] = [];
    let starTextureDisp: THREE.Texture | null = null;

    const buildStarVisuals = (starCfg: SolarSystemConfig['star']) => {
      while (starGroup.children.length > 0) {
        const ch = starGroup.children[0] as THREE.Mesh;
        if (ch.geometry && ch.geometry !== sphereGeo) ch.geometry.dispose();
        if (ch.material) {
          if (Array.isArray(ch.material)) ch.material.forEach((m) => m.dispose());
          else ch.material.dispose();
        }
        starGroup.remove(ch);
      }
      if (starTextureDisp) {
        starTextureDisp.dispose();
        starTextureDisp = null;
      }

      const r = starCfg.radius;
      starTextureDisp = createStarTexture(starCfg.color, starCfg.coronaColor);

      // Part 1: Primary Photosphere Core
      const coreMat = new THREE.MeshStandardMaterial({
        map: starTextureDisp,
        color: 0xffffff,
        emissive: new THREE.Color(starCfg.color),
        emissiveMap: starTextureDisp,
        emissiveIntensity: 1.35,
        roughness: 0.2,
        metalness: 0.0,
      });
      const coreMesh = new THREE.Mesh(sphereGeo, coreMat);
      coreMesh.scale.setScalar(r);
      coreMesh.userData = { bodyId: 'STAR' };
      starGroup.add(coreMesh);

      // Part 2: Inner Chromosphere Glow Shell
      const chromoMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(starCfg.coronaColor),
        transparent: true,
        opacity: 0.28,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const chromoMesh = new THREE.Mesh(sphereGeo, chromoMat);
      chromoMesh.scale.setScalar(r * 1.14);
      starGroup.add(chromoMesh);

      // Part 3: Outer Corona Atmosphere Shell
      const coronaMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(starCfg.coronaColor),
        transparent: true,
        opacity: 0.12,
        side: THREE.BackSide,
        depthWrite: false,
      });
      const coronaMesh = new THREE.Mesh(sphereGeo, coronaMat);
      coronaMesh.scale.setScalar(r * 1.42);
      starGroup.add(coronaMesh);

      // Part 4: Equatorial Solar Wind Ring
      const eqGeo = new THREE.TorusGeometry(r * 1.24, r * 0.025, 12, 64);
      const eqMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(starCfg.color),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const eqRing = new THREE.Mesh(eqGeo, eqMat);
      eqRing.rotation.x = Math.PI / 2;
      starGroup.add(eqRing);

      // Parts 5 & 6: Magnetic Solar Prominence Loops
      for (let i = 0; i < 2; i++) {
        const promGeo = new THREE.TorusGeometry(r * 0.38, r * 0.03, 10, 32, Math.PI);
        const promMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(starCfg.coronaColor),
          transparent: true,
          opacity: 0.65,
        });
        const promMesh = new THREE.Mesh(promGeo, promMat);
        const angle = i * Math.PI + 0.6;
        promMesh.position.set(Math.cos(angle) * (r * 0.92), (i === 0 ? 1 : -1) * r * 0.2, Math.sin(angle) * (r * 0.92));
        promMesh.rotation.y = -angle;
        promMesh.rotation.z = i === 0 ? 0.35 : -0.4;
        starGroup.add(promMesh);
      }

      // Sync PointLight color & intensity
      starLight.color.set(starCfg.color);
      starLight.intensity = starCfg.intensity * 2.4;
    };

    const disposePlanetNode = (node: PlanetRuntimeNode) => {
      scene.remove(node.rootGroup);
      scene.remove(node.orbitLine);
      scene.remove(node.perihelionMarker);
      node.textures.forEach((t) => t.dispose());
      node.orbitLine.geometry.dispose();
      (node.orbitLine.material as THREE.Material).dispose();
      (node.perihelionMarker.material as THREE.Material).dispose();
      node.rootGroup.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          if (m.geometry && m.geometry !== sphereGeo && m.geometry !== lowSphereGeo && m.geometry !== nodeMarkerGeo) {
            m.geometry.dispose();
          }
          if (m.material) {
            if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
            else m.material.dispose();
          }
        }
      });
    };

    const rebuildSystemScene = (cfg: SolarSystemConfig, preserveAngles = true) => {
      buildStarVisuals(cfg.star);

      // Preserve existing orbital angles if updating parameters live
      const previousAngles = new Map<string, number>();
      if (preserveAngles) {
        planetNodes.forEach((node, id) => {
          previousAngles.set(id, node.theta);
        });
      }

      // Dispose old planet nodes
      planetNodes.forEach((node) => disposePlanetNode(node));
      planetNodes.clear();
      clickableMeshes = [];

      // Add star core to clickable meshes
      if (starGroup.children[0]) {
        clickableMeshes.push(starGroup.children[0]);
      }

      cfg.planets.forEach((planet) => {
        const rootGroup = new THREE.Group();
        const tiltGroup = new THREE.Group();
        tiltGroup.rotation.z = THREE.MathUtils.degToRad(planet.axialTilt);
        rootGroup.add(tiltGroup);

        const { colorMap, bumpMap } = createProceduralPlanetTextures(planet, maxAnisotropy);
        const textures: THREE.Texture[] = [colorMap, bumpMap];

        // Configure PBR surface properties by planetary class
        const isGasOrIce = planet.surfaceType === 'gas_giant' || planet.surfaceType === 'ice_giant';
        const isCrystalline = planet.surfaceType === 'crystalline';
        const isOceanic = planet.surfaceType === 'oceanic';
        const isVolcanic = planet.surfaceType === 'volcanic';

        // Part 1: Primary Planetary Sphere
        const surfaceMat = new THREE.MeshStandardMaterial({
          map: colorMap,
          color: 0xffffff,
          bumpMap,
          bumpScale: isGasOrIce ? 0.015 : 0.06,
          roughness: isCrystalline ? 0.18 : isOceanic ? 0.38 : isGasOrIce ? 0.62 : 0.82,
          metalness: isCrystalline ? 0.65 : isOceanic ? 0.15 : 0.08,
          emissive: isVolcanic ? new THREE.Color(planet.secondaryColor) : new THREE.Color(0x000000),
          emissiveIntensity: isVolcanic ? 0.28 : 0,
        });

        const surfaceMesh = new THREE.Mesh(sphereGeo, surfaceMat);
        surfaceMesh.scale.setScalar(planet.radius);
        surfaceMesh.castShadow = !isSoftwareGl;
        surfaceMesh.receiveShadow = !isSoftwareGl;
        surfaceMesh.userData = { bodyId: planet.id };
        tiltGroup.add(surfaceMesh);
        clickableMeshes.push(surfaceMesh);

        // Part 2: Polar Axis Telemetry Pin (subtle north/south rotational axis rod)
        const axisGeo = new THREE.CylinderGeometry(0.025, 0.025, planet.radius * 2.65, 8);
        const axisMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(planet.atmosphereColor),
          transparent: true,
          opacity: 0.45,
        });
        const axisMesh = new THREE.Mesh(axisGeo, axisMat);
        tiltGroup.add(axisMesh);

        // Part 3: Atmospheric Rim Halo & Dynamic Cloud Deck (if hasAtmosphere)
        let atmosphereMesh: THREE.Mesh | undefined;
        let cloudMesh: THREE.Mesh | undefined;
        if (planet.hasAtmosphere) {
          const atmoMat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(planet.atmosphereColor),
            transparent: true,
            opacity: 0.22,
            roughness: 0.15,
            metalness: 0.0,
            clearcoat: 1.0,
            side: THREE.BackSide,
            depthWrite: false,
          });
          atmosphereMesh = new THREE.Mesh(sphereGeo, atmoMat);
          atmosphereMesh.scale.setScalar(planet.radius * 1.11);
          tiltGroup.add(atmosphereMesh);

          if (isOceanic || isGasOrIce) {
            const cloudMat = new THREE.MeshStandardMaterial({
              color: isOceanic ? 0xffffff : new THREE.Color(planet.atmosphereColor),
              transparent: true,
              opacity: isOceanic ? 0.24 : 0.16,
              roughness: 0.9,
              depthWrite: false,
            });
            cloudMesh = new THREE.Mesh(sphereGeo, cloudMat);
            cloudMesh.scale.setScalar(planet.radius * 1.03);
            tiltGroup.add(cloudMesh);
          }
        }

        // Part 4: Multi-Band Planetary Ring System (if hasRings)
        let ringMesh: THREE.Mesh | undefined;
        if (planet.hasRings) {
          const innerR = planet.radius * planet.ringInnerRadius;
          const outerR = planet.radius * Math.max(planet.ringInnerRadius + 0.3, planet.ringOuterRadius);
          const ringGeo = new THREE.RingGeometry(innerR, outerR, 72, 1);

          // Remap RingGeometry UVs radially so 1D ring texture maps from innerR (u=0) to outerR (u=1)
          const posAttr = ringGeo.attributes.position;
          const uvAttr = ringGeo.attributes.uv;
          const v3 = new THREE.Vector3();
          for (let i = 0; i < posAttr.count; i++) {
            v3.fromBufferAttribute(posAttr, i);
            const dist = v3.length();
            const u = (dist - innerR) / Math.max(0.001, outerR - innerR);
            uvAttr.setXY(i, u, 0.5);
          }

          const ringTex = createRingTexture(planet.ringColor, maxAnisotropy);
          textures.push(ringTex);

          const ringMat = new THREE.MeshStandardMaterial({
            map: ringTex,
            color: 0xffffff,
            side: THREE.DoubleSide,
            transparent: true,
            roughness: 0.65,
            metalness: 0.15,
            depthWrite: false,
          });
          ringMesh = new THREE.Mesh(ringGeo, ringMat);
          ringMesh.rotation.x = Math.PI / 2 + THREE.MathUtils.degToRad(planet.ringTilt);
          ringMesh.receiveShadow = !isSoftwareGl;
          tiltGroup.add(ringMesh);
        }

        // Part 5: Orbiting Moons System (0 to 5 moons)
        const moonsGroup = new THREE.Group();
        rootGroup.add(moonsGroup);
        for (let m = 0; m < planet.moonCount; m++) {
          const moonPivot = new THREE.Group();
          const moonOrbitR =
            planet.radius * (planet.hasRings ? planet.ringOuterRadius + 0.65 : 1.75) + m * (planet.radius * 0.65 + 0.55);
          moonPivot.rotation.z = (m % 2 === 0 ? 1 : -1) * (0.08 + m * 0.05);
          moonPivot.rotation.y = m * 1.4;
          moonPivot.userData = { orbitSpeed: 2.2 / Math.pow(1 + m * 0.5, 0.8) };

          // Subtle moon orbital path ring
          const mOrbitGeo = new THREE.BufferGeometry().setFromPoints(
            new THREE.Path().absarc(0, 0, moonOrbitR, 0, Math.PI * 2, false).getPoints(48)
          );
          mOrbitGeo.rotateX(Math.PI / 2);
          const mOrbitMat = new THREE.LineBasicMaterial({
            color: 0x64748b,
            transparent: true,
            opacity: 0.28,
          });
          const mOrbitLine = new THREE.Line(mOrbitGeo, mOrbitMat);
          moonPivot.add(mOrbitLine);

          const moonRadius = Math.max(0.14, Math.min(0.45, planet.radius * (0.16 - m * 0.015)));
          const moonMat = new THREE.MeshStandardMaterial({
            color: m % 2 === 0 ? 0xcbd5e1 : 0x94a3b8,
            roughness: 0.88,
            metalness: 0.1,
          });
          const moonMesh = new THREE.Mesh(lowSphereGeo, moonMat);
          moonMesh.scale.setScalar(moonRadius);
          moonMesh.position.set(moonOrbitR, 0, 0);
          moonPivot.add(moonMesh);

          moonsGroup.add(moonPivot);
        }

        // Elliptical Keplerian Orbit Path Line (brightened for high contrast against deep space)
        const orbitPts = generateOrbitPoints(planet, 144).map((p) => new THREE.Vector3(p.x, p.y, p.z));
        const orbitGeo = new THREE.BufferGeometry().setFromPoints(orbitPts);
        const brightOrbitColor = new THREE.Color(planet.color).lerp(new THREE.Color(0xffffff), 0.35);
        const orbitMat = new THREE.LineBasicMaterial({
          color: brightOrbitColor,
          transparent: true,
          opacity: selectedBodyIdRef.current === planet.id ? 0.98 : 0.65,
        });
        const orbitLine = new THREE.Line(orbitGeo, orbitMat);
        orbitLine.visible = showOrbitsRef.current;
        scene.add(orbitLine);

        // Perihelion Orbital Node Marker
        const periPos = calculateOrbitalPosition(planet, 0);
        const periMat = new THREE.MeshBasicMaterial({
          color: brightOrbitColor,
          transparent: true,
          opacity: 0.85,
        });
        const perihelionMarker = new THREE.Mesh(nodeMarkerGeo, periMat);
        perihelionMarker.position.set(periPos.x, periPos.y, periPos.z);
        perihelionMarker.visible = showOrbitsRef.current;
        scene.add(perihelionMarker);

        // Set initial planetary position
        const initialTheta = previousAngles.get(planet.id) ?? 0;
        const pos = calculateOrbitalPosition(planet, initialTheta);
        rootGroup.position.set(pos.x, pos.y, pos.z);
        scene.add(rootGroup);

        planetNodes.set(planet.id, {
          id: planet.id,
          rootGroup,
          tiltGroup,
          surfaceMesh,
          cloudMesh,
          atmosphereMesh,
          ringMesh,
          moonsGroup,
          orbitLine,
          perihelionMarker,
          theta: initialTheta,
          textures,
        });
      });
    };

    const focusOnBody = (
      bodyId: string | null,
      mode: 'overview' | 'chase' | 'equatorial' | 'polar' = cameraModeRef.current
    ) => {
      selectedBodyIdRef.current = bodyId;
      cameraModeRef.current = mode;
      cameraTransitionActive = true;

      // Highlight selected planet's orbit line
      planetNodes.forEach((node, id) => {
        const mat = node.orbitLine.material as THREE.LineBasicMaterial;
        mat.opacity = id === bodyId ? 0.98 : 0.65;
      });
    };

    rebuildSystemScene(systemConfigRef.current, false);
    // Start in full Solar System Overview with Earth selected in the inspector
    focusOnBody('earth', 'overview');

    // Raycasting for clicking directly on 3D planets or the Star
    const raycaster = new THREE.Raycaster();
    const pointerDownPos = new THREE.Vector2();
    const mouse = new THREE.Vector2();

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos.set(e.clientX, e.clientY);
    };

    const onPointerUp = (e: PointerEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > 6) return; // Ignore orbit drag gestures

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(clickableMeshes, false);
      if (hits.length > 0) {
        const hitBodyId = hits[0].object.userData?.bodyId;
        if (hitBodyId) {
          setSelectedBodyId(hitBodyId);
          setInspectorOpen(true);
          if (cameraModeRef.current === 'overview') {
            setCameraMode('chase');
            focusOnBody(hitBodyId, 'chase');
          } else {
            focusOnBody(hitBodyId, cameraModeRef.current);
          }
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // Pre-warm shaders on GPU
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // Window resize handler
    const onResize = () => {
      if (!mount) return;
      const w = mount.clientWidth || window.innerWidth;
      const h = mount.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.render(scene, camera);
    };
    window.addEventListener('resize', onResize);

    // Animation & Software-WebGL Paced Render Loop
    let frameId = 0;
    let lastTime = performance.now();
    let lastHudSync = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (!sync) {
          frameId = window.setTimeout(cb, 80);
          return;
        }
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      const now = performance.now();
      const rawDt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      const simDt = isPlayingRef.current ? rawDt * timeScaleRef.current : 0;

      // Rotate central star and asteroid belt slowly
      starGroup.rotation.y += rawDt * 0.18;
      if (showAsteroidsRef.current) {
        asteroidBelt.rotation.y += simDt * 0.06;
      }

      // Advance each planet along its Keplerian orbit
      const cfg = systemConfigRef.current;
      for (let i = 0; i < cfg.planets.length; i++) {
        const p = cfg.planets[i];
        const node = planetNodes.get(p.id);
        if (!node) continue;

        if (simDt !== 0) {
          const dTheta = calculateInstantaneousAngularSpeed(p, node.theta) * simDt;
          node.theta = (node.theta + dTheta) % (Math.PI * 2);
        }

        const pos = calculateOrbitalPosition(p, node.theta);
        node.rootGroup.position.set(pos.x, pos.y, pos.z);

        // Self-rotation & cloud differential rotation
        node.surfaceMesh.rotation.y += (simDt || rawDt * 0.15) * p.rotationSpeed;
        if (node.cloudMesh) {
          node.cloudMesh.rotation.y += (simDt || rawDt * 0.15) * (p.rotationSpeed * 1.28);
        }

        // Advance moon sub-orbits
        for (let m = 0; m < node.moonsGroup.children.length; m++) {
          const moonPivot = node.moonsGroup.children[m];
          const mSpeed = moonPivot.userData.orbitSpeed || 1.5;
          moonPivot.rotation.y += (simDt || rawDt * 0.2) * mSpeed;
        }
      }

      // Camera Choreography: Seamless Planet Tracking & Smooth Exponential Damping
      const focusedId = selectedBodyIdRef.current;
      const mode = cameraModeRef.current;

      if (mode === 'overview' || !focusedId) {
        _desiredCamTarget.set(0, -10, 0);
        if (cameraTransitionActive) {
          const dampFactor = 1 - Math.exp(-7.5 * rawDt);
          controls.target.lerp(_desiredCamTarget, dampFactor);
          const idealOverviewPos = new THREE.Vector3(-14, 28, 66);
          camera.position.lerp(idealOverviewPos, dampFactor);
          if (camera.position.distanceTo(idealOverviewPos) < 1.2) {
            cameraTransitionActive = false;
          }
        }
      } else {
        let bodyRadius = cfg.star.radius;
        if (focusedId === 'STAR') {
          _planetWorldPos.set(0, -cfg.star.radius * 0.55, 0);
        } else {
          const targetNode = planetNodes.get(focusedId);
          const pData = cfg.planets.find((item) => item.id === focusedId);
          if (targetNode && pData) {
            _planetWorldPos.copy(targetNode.rootGroup.position);
            bodyRadius = pData.radius * (pData.hasRings ? 1.85 : 1.25);
            // Offset target slightly downward so planet centers in the upper open viewport above the bottom dock
            _planetWorldPos.y -= bodyRadius * 0.85;
          }
        }

        // Move camera alongside the moving planet so orbit controls stay locked to the planet frame
        _targetDelta.subVectors(_planetWorldPos, controls.target);
        const trackAlpha = 1 - Math.exp(-14 * rawDt);
        controls.target.addScaledVector(_targetDelta, trackAlpha);
        camera.position.addScaledVector(_targetDelta, trackAlpha);

        if (cameraTransitionActive) {
          const dist = Math.max(6.5, bodyRadius * 4.6);
          const offset = new THREE.Vector3();
          if (mode === 'polar') {
            offset.set(0.1, dist * 1.35, 0.1);
          } else if (mode === 'equatorial') {
            offset.set(dist * 0.85, bodyRadius * 0.35, dist * 0.85);
          } else {
            // 'chase'
            offset.set(dist * 0.88, dist * 0.48, dist * 1.02);
          }
          const desiredCamPos = _planetWorldPos.clone().add(offset);
          const transitionAlpha = 1 - Math.exp(-8.5 * rawDt);
          camera.position.lerp(desiredCamPos, transitionAlpha);
          if (camera.position.distanceTo(desiredCamPos) < 0.45) {
            cameraTransitionActive = false;
          }
        }
      }

      controls.update();
      renderer.render(scene, camera);

      // Throttle React HUD telemetry & 2D projected label updates to ~10Hz
      if (now - lastHudSync > 100) {
        lastHudSync = now;
        if (isPlayingRef.current) {
          setSimYears((prev) => Number((prev + simDt * 0.16).toFixed(2)));
        }

        if (showLabelsRef.current) {
          const w = renderer.domElement.clientWidth;
          const h = renderer.domElement.clientHeight;
          const nextLabels: Record<string, { x: number; y: number; visible: boolean }> = {};

          // Star label
          _projVec.set(0, cfg.star.radius + 1.8, 0).project(camera);
          nextLabels['STAR'] = {
            x: ((_projVec.x + 1) * 0.5) * w,
            y: (-(_projVec.y - 1) * 0.5) * h,
            visible: _projVec.z < 1,
          };

          cfg.planets.forEach((p) => {
            const node = planetNodes.get(p.id);
            if (!node) return;
            _projVec.copy(node.rootGroup.position);
            _projVec.y += p.radius + 1.1;
            _projVec.project(camera);
            nextLabels[p.id] = {
              x: ((_projVec.x + 1) * 0.5) * w,
              y: (-(_projVec.y - 1) * 0.5) * h,
              visible: _projVec.z < 1,
            };
          });
          setLabelPositions(nextLabels);
        }
      }

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    frameId = requestAnimationFrame(tick);

    sceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      starGroup,
      starLight,
      hemiLight,
      gridHelper,
      asteroidBelt,
      planetNodes,
      clickableMeshes,
      cameraTransitionActive,
      rebuildSystemScene,
      focusOnBody,
    };

    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      planetNodes.forEach((node) => disposePlanetNode(node));
      renderer.dispose();
    };
  }, []);

  // Currently selected planet or star data
  const selectedPlanet = useMemo(
    () => systemConfig.planets.find((p) => p.id === selectedBodyId) ?? null,
    [systemConfig.planets, selectedBodyId]
  );

  const selectedTelemetry = useMemo(
    () =>
      selectedPlanet
        ? computePlanetTelemetry(selectedPlanet, systemConfig.star.temperatureK)
        : null,
    [selectedPlanet, systemConfig.star.temperatureK]
  );

  // Handlers for camera & planet selection
  const handleSelectBody = (
    bodyId: string | null,
    mode: 'overview' | 'chase' | 'equatorial' | 'polar' = 'chase'
  ) => {
    setSelectedBodyId(bodyId);
    setCameraMode(mode);
    if (bodyId) setInspectorOpen(true);
    sceneRef.current?.focusOnBody(bodyId, mode);
  };

  // Update a single planet's parameter
  const handleUpdatePlanet = (planetId: string, patch: Partial<PlanetData>) => {
    setSystemConfig((prev) => ({
      ...prev,
      planets: prev.planets.map((p) => (p.id === planetId ? { ...p, ...patch } : p)),
    }));
  };

  // Update central star parameter
  const handleUpdateStar = (patch: Partial<SolarSystemConfig['star']>) => {
    setSystemConfig((prev) => ({
      ...prev,
      star: { ...prev.star, ...patch },
    }));
  };

  // Add a new custom planet
  const handleAddPlanetSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const created = createNewPlanet(systemConfig.planets, {
      name: newPlanetName.trim() || `Planet-${systemConfig.planets.length + 1}`,
      surfaceType: newPlanetSurface,
      radius: newPlanetRadius,
      distance: newPlanetDistance,
      eccentricity: newPlanetEccentricity,
      hasRings: newPlanetRings,
      moonCount: newPlanetMoons,
    });

    setSystemConfig((prev) => ({
      ...prev,
      planets: [...prev.planets, created],
    }));
    setIsAddPlanetOpen(false);
    setSelectedBodyId(created.id);
    setCameraMode('chase');
    setInspectorOpen(true);
    setTimeout(() => {
      sceneRef.current?.focusOnBody(created.id, 'chase');
    }, 30);

    // Prepare defaults for next planet creation
    setNewPlanetName(`Nova-${systemConfig.planets.length + 2}`);
    setNewPlanetDistance(Math.min(240, Math.round(created.distance + 18)));
  };

  // Duplicate selected planet
  const handleDuplicatePlanet = (planet: PlanetData) => {
    const copy = createNewPlanet(systemConfig.planets, {
      ...planet,
      id: `planet-${Date.now()}`,
      name: `${planet.name} II`,
      distance: Math.min(240, Number((planet.distance + 12).toFixed(1))),
      initialPhase: (planet.initialPhase + 1.1) % (Math.PI * 2),
    });
    setSystemConfig((prev) => ({
      ...prev,
      planets: [...prev.planets, copy],
    }));
    handleSelectBody(copy.id, 'chase');
  };

  // Delete selected planet
  const handleDeletePlanet = (planetId: string) => {
    if (systemConfig.planets.length <= 1) return;
    const remaining = systemConfig.planets.filter((p) => p.id !== planetId);
    setSystemConfig((prev) => ({
      ...prev,
      planets: remaining,
    }));
    handleSelectBody(remaining[0]?.id ?? null, 'overview');
  };

  // Save current solar system configuration to localStorage
  const handleSaveCurrentConfig = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = saveNameInput.trim();
    if (!cleanName) {
      setConfigFeedback({ type: 'error', message: 'Please provide a configuration name.' });
      return;
    }
    const newSaved: SolarSystemConfig = {
      ...systemConfig,
      id: `custom-${Date.now()}`,
      name: cleanName,
      description: saveDescInput.trim() || 'User-created solar system configuration.',
      createdAt: new Date().toISOString(),
    };
    const nextList = [newSaved, ...savedConfigs];
    setSavedConfigs(nextList);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextList));
    } catch {
      // Ignore storage quota errors in restricted sandboxes
    }
    setSystemConfig(newSaved);
    setConfigFeedback({
      type: 'success',
      message: `Saved "${cleanName}" (${newSaved.planets.length} planets) to custom configurations.`,
    });
  };

  // Load any preset or saved configuration
  const handleLoadConfig = (cfg: SolarSystemConfig) => {
    const deepCopy: SolarSystemConfig = JSON.parse(JSON.stringify(cfg));
    setSystemConfig(deepCopy);
    const firstPlanetId = deepCopy.planets[0]?.id ?? null;
    setSelectedBodyId(firstPlanetId);
    setCameraMode('overview');
    setTimeout(() => {
      sceneRef.current?.rebuildSystemScene(deepCopy, false);
      sceneRef.current?.focusOnBody(null, 'overview');
    }, 20);
    setConfigFeedback({
      type: 'success',
      message: `Loaded system "${deepCopy.name}" with ${deepCopy.planets.length} orbiting bodies.`,
    });
  };

  // Delete a saved custom config
  const handleDeleteSavedConfig = (id: string) => {
    const updated = savedConfigs.filter((c) => c.id !== id);
    setSavedConfigs(updated);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore storage error
    }
  };

  // Export JSON string or download file
  const handleCopyJson = () => {
    const jsonStr = JSON.stringify(systemConfig, null, 2);
    navigator.clipboard?.writeText(jsonStr).catch(() => {});
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const handleDownloadJson = () => {
    const jsonStr = JSON.stringify(systemConfig, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${systemConfig.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import JSON configuration
  const handleImportJson = () => {
    try {
      const parsed = JSON.parse(importJsonText);
      const validated = validateSystemConfig(parsed);
      if (!validated) {
        setConfigFeedback({
          type: 'error',
          message: 'Invalid configuration format: must include a name and at least 1 planet.',
        });
        return;
      }
      const nextList = [validated, ...savedConfigs];
      setSavedConfigs(nextList);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextList));
      } catch {
        // Ignore
      }
      handleLoadConfig(validated);
      setImportJsonText('');
    } catch {
      setConfigFeedback({
        type: 'error',
        message: 'Could not parse JSON. Check syntax and try again.',
      });
    }
  };

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-[#05070e] text-slate-100 select-none"
      data-state={isPlaying ? 'playing' : 'paused'}
    >
      {/* Persistent Three.js WebGL Viewport Container */}
      <div
        ref={canvasMountRef}
        data-testid="solar-canvas-container"
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing"
      />

      {/* 2D Projected Interactive Planet Labels in Viewport */}
      {showLabels && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-10">
          {/* Star Label */}
          {labelPositions['STAR']?.visible && (
            <button
              type="button"
              onClick={() => handleSelectBody('STAR', 'chase')}
              style={{
                transform: `translate3d(${Math.round(labelPositions['STAR'].x)}px, ${Math.round(
                  labelPositions['STAR'].y
                )}px, 0) translate(-50%, -100%)`,
              }}
              className={`pointer-events-auto absolute top-0 left-0 px-2 py-0.5 rounded text-[11px] font-mono tracking-wide transition-colors whitespace-nowrap ${
                selectedBodyId === 'STAR'
                  ? 'bg-amber-500/95 text-slate-950 font-semibold border border-amber-300'
                  : 'bg-[#0b0f19]/85 text-amber-300 border border-amber-500/30 hover:border-amber-400'
              }`}
            >
              ★ {systemConfig.star.name}
            </button>
          )}

          {/* Planet Labels */}
          {systemConfig.planets.map((planet) => {
            const pos = labelPositions[planet.id];
            if (!pos || !pos.visible) return null;
            const isSelected = selectedBodyId === planet.id;
            return (
              <button
                key={planet.id}
                type="button"
                onClick={() => handleSelectBody(planet.id, 'chase')}
                style={{
                  transform: `translate3d(${Math.round(pos.x)}px, ${Math.round(
                    pos.y
                  )}px, 0) translate(-50%, -100%)`,
                }}
                className={`pointer-events-auto absolute top-0 left-0 flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                  isSelected
                    ? 'bg-cyan-500 text-slate-950 font-semibold border border-cyan-300'
                    : 'bg-[#0b0f19]/85 text-slate-200 border border-slate-700/80 hover:border-cyan-400/70'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: planet.color }}
                />
                <span>{planet.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* TOP BAR CONTRACT: 3 Zones (1-line Brand Wordmark — 4-5 Concise Nav Links — 1 Primary Action) */}
      <header className="relative z-20 flex items-center justify-between gap-8 px-6 py-3 bg-[#080c17]/95 border-b border-slate-800/90">
        {/* Zone 1: Brand Wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            handleSelectBody(null, 'overview');
          }}
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          Helios Orbital Lab
        </a>

        {/* Zone 2: 4 Concise Single-Line System & Workspace Links */}
        <nav
          aria-label="System Presets and Views"
          className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-300"
        >
          <button
            type="button"
            onClick={() => handleLoadConfig(PRESET_SYSTEMS[0])}
            className={`hover:text-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              systemConfig.id === 'sol-system' ? 'text-cyan-400 underline underline-offset-4' : ''
            }`}
          >
            Sol System
          </button>
          <button
            type="button"
            onClick={() => handleLoadConfig(PRESET_SYSTEMS[1])}
            className={`hover:text-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              systemConfig.id === 'trappist-1' ? 'text-cyan-400 underline underline-offset-4' : ''
            }`}
          >
            TRAPPIST-1
          </button>
          <button
            type="button"
            onClick={() => handleLoadConfig(PRESET_SYSTEMS[2])}
            className={`hover:text-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              systemConfig.id === 'hyperion-giants' ? 'text-cyan-400 underline underline-offset-4' : ''
            }`}
          >
            Hyperion Giants
          </button>
          <button
            type="button"
            onClick={() => handleSelectBody('STAR', 'chase')}
            className={`hover:text-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              selectedBodyId === 'STAR' ? 'text-amber-400 underline underline-offset-4' : ''
            }`}
          >
            Star Calibration
          </button>
          <button
            type="button"
            onClick={() => handleSelectBody(null, 'overview')}
            className={`hover:text-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              cameraMode === 'overview' ? 'text-cyan-400 underline underline-offset-4' : ''
            }`}
          >
            System Overview
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setSaveNameInput(systemConfig.name);
              setConfigFeedback(null);
              setIsConfigModalOpen(true);
            }}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 rounded-lg hover:bg-cyan-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Save / Load Config
          </button>
        </div>
      </header>

      {/* Subtle Top-Left Telemetry Readout Strip (Unboxed Typography per Zero-Pill Rule) */}
      <div className="relative z-10 pointer-events-none flex items-center justify-between px-6 py-2.5 text-xs text-slate-400">
        <div className="flex items-center gap-2 font-mono tabular-nums">
          <span className="text-slate-200 font-semibold">{systemConfig.name}</span>
          <span aria-hidden="true">·</span>
          <span>{systemConfig.planets.length} Planets</span>
          <span aria-hidden="true">·</span>
          <span>Epoch {simYears.toFixed(2)} yr</span>
          <span aria-hidden="true">·</span>
          <span className="text-cyan-400">
            {isPlaying ? `${timeScale.toFixed(2)}x Rate` : 'Paused'}
          </span>
        </div>
        <div className="hidden lg:flex items-center gap-2 text-[11px] text-slate-400">
          <span>Drag to Orbit</span>
          <span aria-hidden="true">·</span>
          <span>Scroll to Zoom</span>
          <span aria-hidden="true">·</span>
          <span>Click Any Planet to Focus</span>
        </div>
      </div>

      {/* UNIFIED COLLAPSIBLE BOTTOM CONTROL DOCK */}
      <section
        aria-label="Solar System Simulation and Planetary Parameter Dock"
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(960px,95vw)] transition-transform duration-200"
      >
        {/* Collapse / Expand HUD Toggle Handle */}
        <div className="flex justify-center mb-1.5">
          <button
            type="button"
            onClick={() => setDockCollapsed((prev) => !prev)}
            className="flex items-center gap-1.5 px-3.5 py-1 text-xs font-medium text-slate-300 bg-[#0b101e]/95 border border-slate-700/80 rounded-t-lg hover:text-white hover:border-slate-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />
                <span>Show Controls</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
                <span>Hide Controls</span>
              </>
            )}
          </button>
        </div>

        {!dockCollapsed && (
          <div className="bg-[#0b101e]/95 border border-slate-800 rounded-xl shadow-2xl overflow-hidden">
            {/* EXPANDABLE PLANET / STAR PARAMETER INSPECTOR */}
            {inspectorOpen && selectedBodyId === 'STAR' && (
              <div className="p-4 border-b border-slate-800/90 bg-[#080c17]">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                  <div>
                    <div className="text-xs text-amber-400 font-mono">
                      Central Star Calibration · {systemConfig.star.spectralType}
                    </div>
                    <h2 className="text-base font-bold text-slate-100">
                      {systemConfig.star.name} Photosphere & Dynamic Lighting
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSelectBody(null, 'overview')}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800/90 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Unlock Camera
                    </button>
                    <button
                      type="button"
                      onClick={() => setInspectorOpen(false)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Close Inspector
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label
                      htmlFor="star-name-input"
                      className="block text-xs text-slate-400 mb-1"
                    >
                      Star Designation
                    </label>
                    <input
                      id="star-name-input"
                      type="text"
                      value={systemConfig.star.name}
                      onChange={(e) => handleUpdateStar({ name: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <label htmlFor="star-radius-slider" className="text-slate-400">
                        Solar Radius
                      </label>
                      <span className="font-mono text-amber-300">
                        {systemConfig.star.radius.toFixed(1)} units
                      </span>
                    </div>
                    <input
                      id="star-radius-slider"
                      type="range"
                      min={4.0}
                      max={10.5}
                      step={0.1}
                      value={systemConfig.star.radius}
                      onChange={(e) => handleUpdateStar({ radius: Number(e.target.value) })}
                      className="w-full telemetry-slider"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs mb-1">
                      <label htmlFor="star-intensity-slider" className="text-slate-400">
                        Luminosity / Light Intensity
                      </label>
                      <span className="font-mono text-amber-300">
                        {systemConfig.star.intensity.toFixed(2)}x
                      </span>
                    </div>
                    <input
                      id="star-intensity-slider"
                      type="range"
                      min={0.4}
                      max={3.0}
                      step={0.05}
                      value={systemConfig.star.intensity}
                      onChange={(e) => handleUpdateStar({ intensity: Number(e.target.value) })}
                      className="w-full telemetry-slider"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <div>
                      <label
                        htmlFor="star-color-picker"
                        className="block text-xs text-slate-400 mb-1"
                      >
                        Photosphere
                      </label>
                      <input
                        id="star-color-picker"
                        type="color"
                        value={systemConfig.star.color}
                        onChange={(e) => handleUpdateStar({ color: e.target.value })}
                        className="w-12 h-7 rounded bg-slate-900 border border-slate-700 cursor-pointer"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="star-corona-picker"
                        className="block text-xs text-slate-400 mb-1"
                      >
                        Corona Glow
                      </label>
                      <input
                        id="star-corona-picker"
                        type="color"
                        value={systemConfig.star.coronaColor}
                        onChange={(e) => handleUpdateStar({ coronaColor: e.target.value })}
                        className="w-12 h-7 rounded bg-slate-900 border border-slate-700 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {inspectorOpen && selectedPlanet && selectedTelemetry && (
              <div className="p-4 border-b border-slate-800/90 bg-[#080c17]">
                {/* Header & Live Derived Telemetry Readout */}
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-800/80">
                  <div className="flex items-center gap-3">
                    <span
                      className="w-4 h-4 rounded-full border border-white/30 shrink-0"
                      style={{ backgroundColor: selectedPlanet.color }}
                    />
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="font-semibold text-slate-100 text-sm">
                          {selectedPlanet.name}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono text-cyan-400">
                          {selectedTelemetry.semiMajorAU} AU
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          Period {selectedTelemetry.orbitalPeriodDays} d
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {selectedTelemetry.orbitalVelocityKms} km/s
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {selectedTelemetry.gravityMs2} m/s²
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {selectedTelemetry.eqTempK} K ({selectedTelemetry.eqTempC} °C)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Camera Framing Mode Switcher & Actions */}
                  <div className="flex items-center gap-1.5">
                    <div
                      role="group"
                      aria-label="Camera Framing Mode"
                      className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg"
                    >
                      {(
                        [
                          { id: 'chase', label: 'Chase Cam' },
                          { id: 'equatorial', label: 'Equatorial' },
                          { id: 'polar', label: 'Polar View' },
                          { id: 'overview', label: 'Overview' },
                        ] as const
                      ).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectBody(selectedPlanet.id, m.id)}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                            cameraMode === m.id
                              ? 'bg-cyan-500 text-slate-950 font-semibold'
                              : 'text-slate-400 hover:text-slate-100'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDuplicatePlanet(selectedPlanet)}
                      title="Duplicate Planet"
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-800/90 hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Duplicate
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDeletePlanet(selectedPlanet.id)}
                      disabled={systemConfig.planets.length <= 1}
                      aria-label={`Delete ${selectedPlanet.name}`}
                      className="px-2.5 py-1.5 text-xs font-medium text-rose-300 bg-rose-950/60 hover:bg-rose-900/80 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Delete
                    </button>

                    <button
                      type="button"
                      onClick={() => setInspectorOpen(false)}
                      className="px-2 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Hide
                    </button>
                  </div>
                </div>

                {/* Parameter Controls Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5 items-end">
                  {/* Planet Name */}
                  <div>
                    <label
                      htmlFor="planet-name-input"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Planet Name
                    </label>
                    <input
                      id="planet-name-input"
                      type="text"
                      value={selectedPlanet.name}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, { name: e.target.value })
                      }
                      className="w-full px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  {/* Surface Class */}
                  <div>
                    <label
                      htmlFor="planet-surface-select"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Surface Class
                    </label>
                    <select
                      id="planet-surface-select"
                      value={selectedPlanet.surfaceType}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          surfaceType: e.target.value as SurfaceType,
                        })
                      }
                      className="w-full px-2 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-400"
                    >
                      <option value="terrestrial">Rocky Terrestrial</option>
                      <option value="oceanic">Oceanic Biosphere</option>
                      <option value="gas_giant">Banded Gas Giant</option>
                      <option value="ice_giant">Methane Ice Giant</option>
                      <option value="volcanic">Volcanic Magma</option>
                      <option value="desert">Arid Cratered Desert</option>
                      <option value="crystalline">Crystalline Exoplanet</option>
                    </select>
                  </div>

                  {/* Planetary Radius */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-radius-slider" className="text-slate-400">
                        Radius
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.radius.toFixed(2)} R⊕
                      </span>
                    </div>
                    <input
                      id="planet-radius-slider"
                      type="range"
                      min={0.4}
                      max={4.8}
                      step={0.05}
                      value={selectedPlanet.radius}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          radius: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Semi-Major Orbital Distance */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1 whitespace-nowrap">
                      <label htmlFor="planet-distance-slider" className="text-slate-400">
                        Orbit Dist
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedTelemetry.semiMajorAU} AU
                      </span>
                    </div>
                    <input
                      id="planet-distance-slider"
                      type="range"
                      min={11}
                      max={220}
                      step={1}
                      value={selectedPlanet.distance}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          distance: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Orbital Angular Speed */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-speed-slider" className="text-slate-400">
                        Orbital Speed
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.orbitalSpeed.toFixed(2)} rad/y
                      </span>
                    </div>
                    <input
                      id="planet-speed-slider"
                      type="range"
                      min={-2.5}
                      max={2.5}
                      step={0.02}
                      value={selectedPlanet.orbitalSpeed}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          orbitalSpeed: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Orbital Eccentricity */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-eccentricity-slider" className="text-slate-400">
                        Eccentricity (e)
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.eccentricity.toFixed(3)}
                      </span>
                    </div>
                    <input
                      id="planet-eccentricity-slider"
                      type="range"
                      min={0}
                      max={0.58}
                      step={0.005}
                      value={selectedPlanet.eccentricity}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          eccentricity: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Orbital Inclination */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-inclination-slider" className="text-slate-400">
                        Inclination (i)
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.inclination.toFixed(1)}°
                      </span>
                    </div>
                    <input
                      id="planet-inclination-slider"
                      type="range"
                      min={-35}
                      max={35}
                      step={0.5}
                      value={selectedPlanet.inclination}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          inclination: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Axial Tilt */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-tilt-slider" className="text-slate-400">
                        Axial Tilt
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.axialTilt.toFixed(1)}°
                      </span>
                    </div>
                    <input
                      id="planet-tilt-slider"
                      type="range"
                      min={0}
                      max={180}
                      step={1}
                      value={selectedPlanet.axialTilt}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          axialTilt: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Moons Count */}
                  <div>
                    <div className="flex justify-between text-[11px] mb-1">
                      <label htmlFor="planet-moons-slider" className="text-slate-400">
                        Natural Moons
                      </label>
                      <span className="font-mono text-cyan-300">
                        {selectedPlanet.moonCount}
                      </span>
                    </div>
                    <input
                      id="planet-moons-slider"
                      type="range"
                      min={0}
                      max={5}
                      step={1}
                      value={selectedPlanet.moonCount}
                      onChange={(e) =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          moonCount: Number(e.target.value),
                        })
                      }
                      className="w-full telemetry-slider"
                    />
                  </div>

                  {/* Surface & Secondary Color Swatches */}
                  <div className="flex items-center gap-2">
                    <div>
                      <label
                        htmlFor="planet-primary-color"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Primary
                      </label>
                      <input
                        id="planet-primary-color"
                        type="color"
                        value={selectedPlanet.color}
                        onChange={(e) =>
                          handleUpdatePlanet(selectedPlanet.id, { color: e.target.value })
                        }
                        className="w-10 h-7 rounded bg-slate-900 border border-slate-700 cursor-pointer"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="planet-secondary-color"
                        className="block text-[11px] text-slate-400 mb-1"
                      >
                        Bands/Land
                      </label>
                      <input
                        id="planet-secondary-color"
                        type="color"
                        value={selectedPlanet.secondaryColor}
                        onChange={(e) =>
                          handleUpdatePlanet(selectedPlanet.id, {
                            secondaryColor: e.target.value,
                          })
                        }
                        className="w-10 h-7 rounded bg-slate-900 border border-slate-700 cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Ring System & Atmosphere Toggles */}
                  <div className="col-span-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          hasRings: !selectedPlanet.hasRings,
                        })
                      }
                      className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        selectedPlanet.hasRings
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/60'
                          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {selectedPlanet.hasRings ? '✓ Ring System Active' : '+ Enable Rings'}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        handleUpdatePlanet(selectedPlanet.id, {
                          hasAtmosphere: !selectedPlanet.hasAtmosphere,
                        })
                      }
                      className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        selectedPlanet.hasAtmosphere
                          ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/60'
                          : 'bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200'
                      }`}
                    >
                      {selectedPlanet.hasAtmosphere ? '✓ Atmosphere' : '+ Atmosphere'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* PLANET FOCUS SELECTOR STRIP + ADD PLANET */}
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800/80 bg-[#0b101e]">
              <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 no-scrollbar">
                {/* Star Selector Button */}
                <button
                  type="button"
                  onClick={() => handleSelectBody('STAR', 'chase')}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    selectedBodyId === 'STAR'
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'bg-slate-900 text-amber-300 hover:bg-slate-800 border border-slate-800'
                  }`}
                >
                  <Sun className="w-3.5 h-3.5" />
                  <span>{systemConfig.star.name}</span>
                </button>

                {/* Planet Selector Buttons */}
                {systemConfig.planets.map((planet) => {
                  const active = selectedBodyId === planet.id;
                  return (
                    <button
                      key={planet.id}
                      type="button"
                      onClick={() => handleSelectBody(planet.id, 'chase')}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        active
                          ? 'bg-cyan-500 text-slate-950 font-semibold'
                          : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: planet.color }}
                      />
                      <span>{planet.name}</span>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {selectedBodyId && !inspectorOpen && (
                  <button
                    type="button"
                    onClick={() => setInspectorOpen(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-slate-900 border border-slate-700 rounded-lg hover:border-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>Edit Selected</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setIsAddPlanetOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Planet</span>
                </button>
              </div>
            </div>

            {/* SIMULATION TIME-SCALE SLIDER & SCENE LAYER CONTROLS */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-2.5 bg-[#070b14]">
              {/* Play/Pause & Time-Scale Slider */}
              <div className="flex items-center gap-3 flex-1 min-w-[260px]">
                <button
                  type="button"
                  onClick={() => setIsPlaying((prev) => !prev)}
                  aria-label={isPlaying ? 'Pause Simulation' : 'Play Simulation'}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Play</span>
                    </>
                  )}
                </button>

                <div className="flex items-center gap-2.5 flex-1 max-w-xs">
                  <label
                    htmlFor="time-scale-slider"
                    className="text-xs font-medium text-slate-400 whitespace-nowrap shrink-0"
                  >
                    Time Scale
                  </label>
                  <input
                    id="time-scale-slider"
                    type="range"
                    min={0}
                    max={5}
                    step={0.05}
                    value={timeScale}
                    onChange={(e) => setTimeScale(Number(e.target.value))}
                    className="w-full telemetry-slider"
                  />
                  <span className="text-xs font-mono text-cyan-400 w-12 text-right shrink-0">
                    {timeScale.toFixed(2)}x
                  </span>
                </div>

                {/* Quick Speed Multipliers */}
                <div className="hidden sm:flex items-center gap-1">
                  {[0.25, 1.0, 2.5, 5.0].map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      onClick={() => {
                        setTimeScale(spd);
                        setIsPlaying(true);
                      }}
                      className={`px-2 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        Math.abs(timeScale - spd) < 0.03 && isPlaying
                          ? 'bg-slate-700 text-cyan-300 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {spd}x
                    </button>
                  ))}
                </div>
              </div>

              {/* Layer & Lighting Toggles */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowOrbits((prev) => !prev)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    showOrbits
                      ? 'bg-slate-800 text-cyan-300 border-slate-600'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  Orbital Paths
                </button>
                <button
                  type="button"
                  onClick={() => setShowLabels((prev) => !prev)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    showLabels
                      ? 'bg-slate-800 text-cyan-300 border-slate-600'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  Labels
                </button>
                <button
                  type="button"
                  onClick={() => setShowGrid((prev) => !prev)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    showGrid
                      ? 'bg-slate-800 text-cyan-300 border-slate-600'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  Ecliptic Grid
                </button>
                <button
                  type="button"
                  onClick={() => setObservatoryFillLight((prev) => !prev)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    observatoryFillLight
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                      : 'bg-slate-900 text-slate-400 border-slate-800'
                  }`}
                >
                  Night-Side Fill
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ADD PLANET MODAL DIALOG */}
      {isAddPlanetOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-planet-dialog-title"
          className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-black/75"
        >
          <div className="w-full max-w-md bg-[#0b101e] border border-slate-700 rounded-xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 id="add-planet-dialog-title" className="text-lg font-bold text-slate-100">
                Synthesize New Planetary Body
              </h2>
              <button
                type="button"
                onClick={() => setIsAddPlanetOpen(false)}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Cancel
              </button>
            </div>

            <form onSubmit={handleAddPlanetSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="new-planet-name"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Planet Designation
                  </label>
                  <input
                    id="new-planet-name"
                    type="text"
                    required
                    value={newPlanetName}
                    onChange={(e) => setNewPlanetName(e.target.value)}
                    placeholder="e.g. Kepler-452b"
                    className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                </div>

                <div>
                  <label
                    htmlFor="new-planet-surface"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    Surface Classification
                  </label>
                  <select
                    id="new-planet-surface"
                    value={newPlanetSurface}
                    onChange={(e) => setNewPlanetSurface(e.target.value as SurfaceType)}
                    className="w-full px-3 py-2 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-cyan-400"
                  >
                    <option value="oceanic">Oceanic Biosphere</option>
                    <option value="terrestrial">Rocky Terrestrial</option>
                    <option value="gas_giant">Banded Gas Giant</option>
                    <option value="ice_giant">Methane Ice Giant</option>
                    <option value="volcanic">Volcanic Magma World</option>
                    <option value="desert">Cratered Desert</option>
                    <option value="crystalline">Crystalline Exoplanet</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <label htmlFor="new-planet-radius" className="text-slate-300">
                      Planetary Radius
                    </label>
                    <span className="font-mono text-cyan-400">{newPlanetRadius.toFixed(2)} R⊕</span>
                  </div>
                  <input
                    id="new-planet-radius"
                    type="range"
                    min={0.5}
                    max={4.5}
                    step={0.05}
                    value={newPlanetRadius}
                    onChange={(e) => setNewPlanetRadius(Number(e.target.value))}
                    className="w-full telemetry-slider"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <label htmlFor="new-planet-distance" className="text-slate-300">
                      Orbital Distance
                    </label>
                    <span className="font-mono text-cyan-400">
                      {(newPlanetDistance / 32).toFixed(2)} AU
                    </span>
                  </div>
                  <input
                    id="new-planet-distance"
                    type="range"
                    min={12}
                    max={220}
                    step={1}
                    value={newPlanetDistance}
                    onChange={(e) => setNewPlanetDistance(Number(e.target.value))}
                    className="w-full telemetry-slider"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <label htmlFor="new-planet-ecc" className="text-slate-300">
                      Eccentricity
                    </label>
                    <span className="font-mono text-cyan-400">
                      {newPlanetEccentricity.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id="new-planet-ecc"
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={newPlanetEccentricity}
                    onChange={(e) => setNewPlanetEccentricity(Number(e.target.value))}
                    className="w-full telemetry-slider"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <label htmlFor="new-planet-moons" className="text-slate-300">
                      Orbiting Moons
                    </label>
                    <span className="font-mono text-cyan-400">{newPlanetMoons}</span>
                  </div>
                  <input
                    id="new-planet-moons"
                    type="range"
                    min={0}
                    max={5}
                    step={1}
                    value={newPlanetMoons}
                    onChange={(e) => setNewPlanetMoons(Number(e.target.value))}
                    className="w-full telemetry-slider"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newPlanetRings}
                    onChange={(e) => setNewPlanetRings(e.target.checked)}
                    className="rounded border-slate-600 text-cyan-500 focus:ring-cyan-400"
                  />
                  <span>Include Planetary Ring System</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAddPlanetOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 rounded-lg hover:bg-cyan-300 transition-colors cursor-pointer"
                >
                  Launch & Focus Planet
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SAVE / LOAD SOLAR SYSTEM CONFIGURATIONS MODAL */}
      {isConfigModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="config-modal-title"
          className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-black/75"
        >
          <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-[#0b101e] border border-slate-700 rounded-xl p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
              <div>
                <h2 id="config-modal-title" className="text-lg font-bold text-slate-100">
                  Solar System Configurations & Presets
                </h2>
                <p className="text-xs text-slate-400">
                  Save custom planetary configurations to browser storage, switch star systems, or export/import JSON.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsConfigModalOpen(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 rounded-lg hover:bg-slate-700 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>

            {configFeedback && (
              <div
                className={`mb-4 px-3.5 py-2.5 rounded-lg text-xs font-medium border ${
                  configFeedback.type === 'success'
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60'
                    : 'bg-rose-950/60 text-rose-300 border-rose-700/60'
                }`}
              >
                {configFeedback.message}
              </div>
            )}

            {/* Save Current System Section */}
            <form
              onSubmit={handleSaveCurrentConfig}
              className="p-4 mb-5 bg-[#070b14] border border-slate-800 rounded-lg"
            >
              <h3 className="text-xs font-semibold text-cyan-400 mb-3">
                01. Save Active Configuration ({systemConfig.planets.length} Planets)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label htmlFor="save-config-name" className="block text-xs text-slate-400 mb-1">
                    Configuration Name
                  </label>
                  <input
                    id="save-config-name"
                    type="text"
                    required
                    value={saveNameInput}
                    onChange={(e) => setSaveNameInput(e.target.value)}
                    placeholder="e.g. Custom Ringed System"
                    className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <div>
                  <label htmlFor="save-config-desc" className="block text-xs text-slate-400 mb-1">
                    Notes / Description
                  </label>
                  <input
                    id="save-config-desc"
                    type="text"
                    value={saveDescInput}
                    onChange={(e) => setSaveDescInput(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyJson}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    {copiedJson ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Copied JSON</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy JSON</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadJson}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download JSON</span>
                  </button>
                </div>
                <button
                  type="submit"
                  className="px-4 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors cursor-pointer"
                >
                  Save to Browser Storage
                </button>
              </div>
            </form>

            {/* Saved Custom Systems & Built-in Presets */}
            <div className="mb-5">
              <h3 className="text-xs font-semibold text-slate-300 mb-2.5">
                02. Saved Custom Systems & Astronomical Presets
              </h3>
              <div className="space-y-2">
                {savedConfigs.map((cfg) => (
                  <div
                    key={cfg.id}
                    className="flex items-center justify-between gap-4 p-3 bg-slate-900/90 border border-cyan-500/30 rounded-lg"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-100">
                        {cfg.name} · {cfg.planets.length} Planets
                      </div>
                      <div className="text-[11px] text-slate-400">{cfg.description}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleLoadConfig(cfg)}
                        className="px-3 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors cursor-pointer"
                      >
                        Load System
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSavedConfig(cfg.id)}
                        aria-label={`Delete saved configuration ${cfg.name}`}
                        className="p-1.5 text-rose-400 hover:bg-rose-950/70 rounded-md transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}

                {PRESET_SYSTEMS.map((preset) => (
                  <div
                    key={preset.id}
                    className="flex items-center justify-between gap-4 p-3 bg-slate-900/60 border border-slate-800 rounded-lg"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-200">
                        {preset.name} · {preset.planets.length} Planets · {preset.star.spectralType}
                      </div>
                      <div className="text-[11px] text-slate-400">{preset.description}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleLoadConfig(preset)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md transition-colors shrink-0 cursor-pointer"
                    >
                      Load Preset
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Import Custom JSON Section */}
            <div className="p-4 bg-[#070b14] border border-slate-800 rounded-lg">
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                03. Import Configuration from JSON
              </h3>
              <textarea
                rows={3}
                value={importJsonText}
                onChange={(e) => setImportJsonText(e.target.value)}
                placeholder='Paste exported solar system JSON here...'
                className="w-full p-2.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded-md text-slate-200 focus:outline-none focus:border-cyan-400 mb-2"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleImportJson}
                  disabled={!importJsonText.trim()}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 rounded-lg transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Validate & Import JSON</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
