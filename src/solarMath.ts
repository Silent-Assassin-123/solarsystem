export type SurfaceType =
  | 'terrestrial'
  | 'oceanic'
  | 'gas_giant'
  | 'ice_giant'
  | 'volcanic'
  | 'desert'
  | 'crystalline';

export interface PlanetData {
  id: string;
  name: string;
  surfaceType: SurfaceType;
  color: string;
  secondaryColor: string;
  atmosphereColor: string;
  hasAtmosphere: boolean;
  radius: number; // Relative to Earth = 1.0 (visual scale units in scene)
  distance: number; // Semi-major axis in scene AU units (e.g. 14 - 160)
  orbitalSpeed: number; // Angular speed multiplier (rad / sim-year)
  eccentricity: number; // 0.0 to 0.65
  inclination: number; // Degrees (-35 to 35)
  axialTilt: number; // Degrees (0 to 180)
  rotationSpeed: number; // Self-rotation speed
  hasRings: boolean;
  ringColor: string;
  ringInnerRadius: number; // Multiplier of planet radius
  ringOuterRadius: number; // Multiplier of planet radius
  ringTilt: number; // Degrees
  moonCount: number; // 0 to 5
  massEarth: number; // Telemetry readout in Earth masses
  meanTempK: number; // Estimated surface temperature in Kelvin
  initialPhase: number; // Radians 0 to 2*PI
}

export interface StarConfig {
  name: string;
  spectralType: string;
  color: string;
  coronaColor: string;
  intensity: number; // Lighting intensity multiplier (0.4 to 3.0)
  radius: number; // Scene units (default 6.5)
  temperatureK: number;
}

export interface SolarSystemConfig {
  id: string;
  name: string;
  description: string;
  star: StarConfig;
  planets: PlanetData[];
  createdAt?: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Computes the 3D position of a planet along its inclined Keplerian elliptical orbit
 * at a given orbital angle theta (in radians).
 * The star sits at the primary focus (0, 0, 0).
 */
export function calculateOrbitalPosition(
  planet: Pick<PlanetData, 'distance' | 'eccentricity' | 'inclination' | 'initialPhase'>,
  theta: number
): Vec3 {
  const a = Math.max(4, planet.distance);
  const e = Math.max(0, Math.min(0.75, planet.eccentricity));
  const incRad = (planet.inclination * Math.PI) / 180;
  const angle = theta + (planet.initialPhase || 0);

  // Polar equation of ellipse from focus: r = a(1 - e^2) / (1 + e * cos(angle))
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(angle));

  const xOrbital = r * Math.cos(angle);
  const zOrbital = r * Math.sin(angle);

  // Apply orbital inclination around the X-axis (ascending node along X)
  const x = xOrbital;
  const y = zOrbital * Math.sin(incRad);
  const z = zOrbital * Math.cos(incRad);

  return { x, y, z };
}

/**
 * Computes instantaneous orbital angular velocity using Kepler's Second Law
 * (conservation of angular momentum: dTheta/dt ~ (a / r)^2 * baseSpeed)
 */
export function calculateInstantaneousAngularSpeed(
  planet: Pick<PlanetData, 'distance' | 'eccentricity' | 'orbitalSpeed' | 'initialPhase'>,
  theta: number
): number {
  const a = Math.max(4, planet.distance);
  const e = Math.max(0, Math.min(0.75, planet.eccentricity));
  const angle = theta + (planet.initialPhase || 0);
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(angle));
  const ratio = a / Math.max(0.1, r);
  return planet.orbitalSpeed * Math.min(3.5, ratio * ratio);
}

/**
 * Generates an array of closed 3D vertices representing the full elliptical orbital path.
 */
export function generateOrbitPoints(
  planet: Pick<PlanetData, 'distance' | 'eccentricity' | 'inclination' | 'initialPhase'>,
  segments = 128
): Vec3[] {
  const points: Vec3[] = [];
  const count = Math.max(16, segments);
  for (let i = 0; i <= count; i++) {
    const theta = (i / count) * Math.PI * 2 - (planet.initialPhase || 0);
    points.push(calculateOrbitalPosition(planet, theta));
  }
  return points;
}

/**
 * Computes realistic astronomical telemetry derived from planetary parameters.
 */
export function computePlanetTelemetry(planet: PlanetData, starTempK = 5778) {
  // Convert scene distance to approximate AU (Earth is at distance = 32 -> 1.00 AU)
  const semiMajorAU = Number((planet.distance / 32).toFixed(2));
  const perihelionAU = Number((semiMajorAU * (1 - planet.eccentricity)).toFixed(2));
  const aphelionAU = Number((semiMajorAU * (1 + planet.eccentricity)).toFixed(2));

  // Kepler's Third Law orbital period in Earth days: T = 365.25 * a^(1.5) / (speed / earthSpeed)
  const speedRatio = Math.max(0.05, Math.abs(planet.orbitalSpeed) / 0.65);
  const orbitalPeriodDays = Math.round((365.25 * Math.pow(semiMajorAU, 1.5)) / speedRatio);

  // Equilibrium temperature scaling ~ starTemp / sqrt(distance)
  const eqTempK = Math.round(
    (planet.meanTempK || 288) * (starTempK / 5778) * Math.pow(32 / Math.max(8, planet.distance), 0.35)
  );

  // Orbital velocity in km/s (Earth ~ 29.78 km/s)
  const orbitalVelocityKms = Number((29.78 / Math.sqrt(Math.max(0.1, semiMajorAU))).toFixed(1));

  // Surface gravity in m/s^2 relative to Earth (9.81 m/s^2)
  // Visual radius is logarithmically compressed for gas/ice giants, so scale physical radius accordingly
  const isGiant = planet.surfaceType === 'gas_giant' || planet.surfaceType === 'ice_giant';
  const effectiveRadiusEarth = isGiant
    ? Math.pow(planet.radius / 1.35, 2.85)
    : planet.radius / 1.35;
  const gravityMs2 = Number(
    (
      9.81 *
      (planet.massEarth / Math.max(0.05, effectiveRadiusEarth * effectiveRadiusEarth))
    ).toFixed(2)
  );

  return {
    semiMajorAU,
    perihelionAU,
    aphelionAU,
    orbitalPeriodDays,
    eqTempK,
    eqTempC: eqTempK - 273,
    orbitalVelocityKms,
    gravityMs2,
  };
}

/**
 * Creates a new custom planet with sensible orbital spacing and surface defaults.
 */
export function createNewPlanet(
  existingPlanets: PlanetData[],
  overrides: Partial<PlanetData> = {}
): PlanetData {
  const maxDist = existingPlanets.reduce((max, p) => Math.max(max, p.distance), 14);
  const nextDistance = overrides.distance ?? Math.min(210, Number((maxDist + 16).toFixed(1)));
  const index = existingPlanets.length + 1;

  const surfacePresets: Record<
    SurfaceType,
    { color: string; secondaryColor: string; atmosphereColor: string; hasAtmosphere: boolean; temp: number; mass: number }
  > = {
    terrestrial: {
      color: '#c26d48',
      secondaryColor: '#6b3824',
      atmosphereColor: '#f59e0b',
      hasAtmosphere: true,
      temp: 245,
      mass: 0.85,
    },
    oceanic: {
      color: '#1d6fa5',
      secondaryColor: '#2e8b57',
      atmosphereColor: '#38bdf8',
      hasAtmosphere: true,
      temp: 288,
      mass: 1.2,
    },
    gas_giant: {
      color: '#d4a373',
      secondaryColor: '#9c6644',
      atmosphereColor: '#fcd34d',
      hasAtmosphere: true,
      temp: 165,
      mass: 95.0,
    },
    ice_giant: {
      color: '#38bdf8',
      secondaryColor: '#0369a1',
      atmosphereColor: '#7dd3fc',
      hasAtmosphere: true,
      temp: 78,
      mass: 14.5,
    },
    volcanic: {
      color: '#3f2e2e',
      secondaryColor: '#f97316',
      atmosphereColor: '#ef4444',
      hasAtmosphere: true,
      temp: 740,
      mass: 0.65,
    },
    desert: {
      color: '#eab308',
      secondaryColor: '#a16207',
      atmosphereColor: '#fde047',
      hasAtmosphere: false,
      temp: 330,
      mass: 0.5,
    },
    crystalline: {
      color: '#a855f7',
      secondaryColor: '#ec4899',
      atmosphereColor: '#c084fc',
      hasAtmosphere: true,
      temp: 190,
      mass: 2.4,
    },
  };

  const surfaceType: SurfaceType = overrides.surfaceType ?? 'oceanic';
  const preset = surfacePresets[surfaceType];

  // Keplerian speed scaling ~ 1 / sqrt(distance)
  const defaultSpeed = Number((0.65 * Math.pow(32 / nextDistance, 0.75)).toFixed(3));

  return {
    id: overrides.id ?? `planet-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: overrides.name?.trim() ? overrides.name.trim() : ` Nova-${index}`,
    surfaceType,
    color: overrides.color ?? preset.color,
    secondaryColor: overrides.secondaryColor ?? preset.secondaryColor,
    atmosphereColor: overrides.atmosphereColor ?? preset.atmosphereColor,
    hasAtmosphere: overrides.hasAtmosphere ?? preset.hasAtmosphere,
    radius: overrides.radius ?? 1.5,
    distance: nextDistance,
    orbitalSpeed: overrides.orbitalSpeed ?? defaultSpeed,
    eccentricity: overrides.eccentricity ?? 0.04,
    inclination: overrides.inclination ?? 2.0,
    axialTilt: overrides.axialTilt ?? 18.0,
    rotationSpeed: overrides.rotationSpeed ?? 1.2,
    hasRings: overrides.hasRings ?? false,
    ringColor: overrides.ringColor ?? '#cbd5e1',
    ringInnerRadius: overrides.ringInnerRadius ?? 1.45,
    ringOuterRadius: overrides.ringOuterRadius ?? 2.35,
    ringTilt: overrides.ringTilt ?? 12,
    moonCount: overrides.moonCount ?? 1,
    massEarth: overrides.massEarth ?? preset.mass,
    meanTempK: overrides.meanTempK ?? preset.temp,
    initialPhase: overrides.initialPhase ?? ((index * 1.37) % (Math.PI * 2)),
  };
}

/**
 * Validates and sanitizes an imported or loaded SolarSystemConfig.
 */
export function validateSystemConfig(raw: unknown): SolarSystemConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) return null;
  if (!Array.isArray(obj.planets) || obj.planets.length === 0) return null;

  const validSurfaceTypes: SurfaceType[] = [
    'terrestrial',
    'oceanic',
    'gas_giant',
    'ice_giant',
    'volcanic',
    'desert',
    'crystalline',
  ];

  const sanitizedPlanets: PlanetData[] = [];
  for (let i = 0; i < obj.planets.length; i++) {
    const p = obj.planets[i] as Record<string, unknown>;
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Body-${i + 1}`;
    const surfaceType: SurfaceType = validSurfaceTypes.includes(p.surfaceType as SurfaceType)
      ? (p.surfaceType as SurfaceType)
      : 'terrestrial';

    sanitizedPlanets.push({
      id: typeof p.id === 'string' && p.id ? p.id : `planet-${i}-${Date.now()}`,
      name,
      surfaceType,
      color: typeof p.color === 'string' ? p.color : '#3b82f6',
      secondaryColor: typeof p.secondaryColor === 'string' ? p.secondaryColor : '#1d4ed8',
      atmosphereColor: typeof p.atmosphereColor === 'string' ? p.atmosphereColor : '#60a5fa',
      hasAtmosphere: Boolean(p.hasAtmosphere ?? true),
      radius: Math.max(0.3, Math.min(6.0, Number(p.radius) || 1.2)),
      distance: Math.max(10, Math.min(260, Number(p.distance) || 20 + i * 15)),
      orbitalSpeed: Math.max(-3.0, Math.min(3.0, Number(p.orbitalSpeed) || 0.5)),
      eccentricity: Math.max(0, Math.min(0.7, Number(p.eccentricity) || 0)),
      inclination: Math.max(-45, Math.min(45, Number(p.inclination) || 0)),
      axialTilt: Math.max(0, Math.min(180, Number(p.axialTilt) || 0)),
      rotationSpeed: Math.max(-5, Math.min(5, Number(p.rotationSpeed) || 1.0)),
      hasRings: Boolean(p.hasRings),
      ringColor: typeof p.ringColor === 'string' ? p.ringColor : '#d6d3d1',
      ringInnerRadius: Math.max(1.2, Math.min(2.2, Number(p.ringInnerRadius) || 1.4)),
      ringOuterRadius: Math.max(1.6, Math.min(3.5, Number(p.ringOuterRadius) || 2.3)),
      ringTilt: Math.max(-60, Math.min(60, Number(p.ringTilt) || 0)),
      moonCount: Math.max(0, Math.min(5, Math.round(Number(p.moonCount) || 0))),
      massEarth: Math.max(0.01, Number(p.massEarth) || 1.0),
      meanTempK: Math.max(20, Math.min(3000, Number(p.meanTempK) || 280)),
      initialPhase: Number(p.initialPhase) || i * 0.9,
    });
  }

  if (sanitizedPlanets.length === 0) return null;

  const rawStar = (obj.star && typeof obj.star === 'object' ? obj.star : {}) as Record<string, unknown>;

  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : `sys-${Date.now()}`,
    name: obj.name.trim(),
    description:
      typeof obj.description === 'string'
        ? obj.description
        : 'Custom planetary system configuration.',
    star: {
      name: typeof rawStar.name === 'string' ? rawStar.name : 'Sol',
      spectralType: typeof rawStar.spectralType === 'string' ? rawStar.spectralType : 'G2V Main Sequence',
      color: typeof rawStar.color === 'string' ? rawStar.color : '#fff4d6',
      coronaColor: typeof rawStar.coronaColor === 'string' ? rawStar.coronaColor : '#f59e0b',
      intensity: Math.max(0.3, Math.min(3.0, Number(rawStar.intensity) || 1.5)),
      radius: Math.max(3.5, Math.min(11.0, Number(rawStar.radius) || 6.5)),
      temperatureK: Math.max(2500, Math.min(12000, Number(rawStar.temperatureK) || 5778)),
    },
    planets: sanitizedPlanets,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
  };
}

export const DEFAULT_SOLAR_SYSTEM: SolarSystemConfig = {
  id: 'sol-system',
  name: 'Sol System (8 Planets)',
  description: 'Our home G2V yellow dwarf star system with inner rocky worlds, main asteroid belt, and outer gas/ice giants.',
  star: {
    name: 'Sol',
    spectralType: 'G2V Yellow Dwarf',
    color: '#fff3d1',
    coronaColor: '#f59e0b',
    intensity: 1.65,
    radius: 6.5,
    temperatureK: 5778,
  },
  planets: [
    {
      id: 'mercury',
      name: 'Mercury',
      surfaceType: 'desert',
      color: '#9ca3af',
      secondaryColor: '#6b7280',
      atmosphereColor: '#94a3b8',
      hasAtmosphere: false,
      radius: 0.72,
      distance: 14,
      orbitalSpeed: 1.35,
      eccentricity: 0.205,
      inclination: 7.0,
      axialTilt: 0.03,
      rotationSpeed: 0.35,
      hasRings: false,
      ringColor: '#9ca3af',
      ringInnerRadius: 1.4,
      ringOuterRadius: 2.0,
      ringTilt: 0,
      moonCount: 0,
      massEarth: 0.055,
      meanTempK: 440,
      initialPhase: 0.4,
    },
    {
      id: 'venus',
      name: 'Venus',
      surfaceType: 'volcanic',
      color: '#eab308',
      secondaryColor: '#ca8a04',
      atmosphereColor: '#fde047',
      hasAtmosphere: true,
      radius: 1.22,
      distance: 22,
      orbitalSpeed: 0.92,
      eccentricity: 0.007,
      inclination: 3.4,
      axialTilt: 177.3,
      rotationSpeed: -0.25,
      hasRings: false,
      ringColor: '#fde047',
      ringInnerRadius: 1.4,
      ringOuterRadius: 2.0,
      ringTilt: 0,
      moonCount: 0,
      massEarth: 0.815,
      meanTempK: 737,
      initialPhase: 1.8,
    },
    {
      id: 'earth',
      name: 'Earth',
      surfaceType: 'oceanic',
      color: '#1d6fa5',
      secondaryColor: '#2e8b57',
      atmosphereColor: '#38bdf8',
      hasAtmosphere: true,
      radius: 1.35,
      distance: 32,
      orbitalSpeed: 0.65,
      eccentricity: 0.017,
      inclination: 0.0,
      axialTilt: 23.44,
      rotationSpeed: 1.4,
      hasRings: false,
      ringColor: '#93c5fd',
      ringInnerRadius: 1.4,
      ringOuterRadius: 2.1,
      ringTilt: 0,
      moonCount: 1,
      massEarth: 1.0,
      meanTempK: 288,
      initialPhase: 3.1,
    },
    {
      id: 'mars',
      name: 'Mars',
      surfaceType: 'terrestrial',
      color: '#c2593f',
      secondaryColor: '#7c2d12',
      atmosphereColor: '#fb923c',
      hasAtmosphere: true,
      radius: 0.95,
      distance: 43,
      orbitalSpeed: 0.48,
      eccentricity: 0.093,
      inclination: 1.85,
      axialTilt: 25.19,
      rotationSpeed: 1.35,
      hasRings: false,
      ringColor: '#fdba74',
      ringInnerRadius: 1.4,
      ringOuterRadius: 2.0,
      ringTilt: 0,
      moonCount: 2,
      massEarth: 0.107,
      meanTempK: 210,
      initialPhase: 4.5,
    },
    {
      id: 'jupiter',
      name: 'Jupiter',
      surfaceType: 'gas_giant',
      color: '#d99b66',
      secondaryColor: '#9a5b32',
      atmosphereColor: '#fdba74',
      hasAtmosphere: true,
      radius: 3.35,
      distance: 66,
      orbitalSpeed: 0.28,
      eccentricity: 0.049,
      inclination: 1.3,
      axialTilt: 3.13,
      rotationSpeed: 2.6,
      hasRings: true,
      ringColor: '#a8a29e',
      ringInnerRadius: 1.32,
      ringOuterRadius: 1.65,
      ringTilt: 3.1,
      moonCount: 4,
      massEarth: 317.8,
      meanTempK: 165,
      initialPhase: 0.9,
    },
    {
      id: 'saturn',
      name: 'Saturn',
      surfaceType: 'gas_giant',
      color: '#e5c185',
      secondaryColor: '#b58d52',
      atmosphereColor: '#fde68a',
      hasAtmosphere: true,
      radius: 2.85,
      distance: 92,
      orbitalSpeed: 0.19,
      eccentricity: 0.057,
      inclination: 2.49,
      axialTilt: 26.73,
      rotationSpeed: 2.3,
      hasRings: true,
      ringColor: '#e7d3b0',
      ringInnerRadius: 1.38,
      ringOuterRadius: 2.45,
      ringTilt: 26.7,
      moonCount: 3,
      massEarth: 95.2,
      meanTempK: 134,
      initialPhase: 2.5,
    },
    {
      id: 'uranus',
      name: 'Uranus',
      surfaceType: 'ice_giant',
      color: '#67e8f9',
      secondaryColor: '#0891b2',
      atmosphereColor: '#a5f3fc',
      hasAtmosphere: true,
      radius: 2.05,
      distance: 118,
      orbitalSpeed: 0.13,
      eccentricity: 0.046,
      inclination: 0.77,
      axialTilt: 97.77,
      rotationSpeed: -1.7,
      hasRings: true,
      ringColor: '#67e8f9',
      ringInnerRadius: 1.35,
      ringOuterRadius: 1.75,
      ringTilt: 75.0,
      moonCount: 2,
      massEarth: 14.5,
      meanTempK: 76,
      initialPhase: 5.1,
    },
    {
      id: 'neptune',
      name: 'Neptune',
      surfaceType: 'ice_giant',
      color: '#2563eb',
      secondaryColor: '#1e3a8a',
      atmosphereColor: '#60a5fa',
      hasAtmosphere: true,
      radius: 1.98,
      distance: 142,
      orbitalSpeed: 0.095,
      eccentricity: 0.011,
      inclination: 1.77,
      axialTilt: 28.32,
      rotationSpeed: 1.8,
      hasRings: false,
      ringColor: '#60a5fa',
      ringInnerRadius: 1.4,
      ringOuterRadius: 1.9,
      ringTilt: 28,
      moonCount: 1,
      massEarth: 17.1,
      meanTempK: 72,
      initialPhase: 3.9,
    },
  ],
};

export const PRESET_SYSTEMS: SolarSystemConfig[] = [
  DEFAULT_SOLAR_SYSTEM,
  {
    id: 'trappist-1',
    name: 'TRAPPIST-1 Compact Exoplanet System',
    description: 'Ultra-cool red dwarf star with tightly packed resonant rocky and oceanic exoplanets.',
    star: {
      name: 'TRAPPIST-1A',
      spectralType: 'M8V Ultra-Cool Red Dwarf',
      color: '#fca5a5',
      coronaColor: '#ef4444',
      intensity: 1.35,
      radius: 5.2,
      temperatureK: 2566,
    },
    planets: [
      {
        id: 'trappist-b',
        name: 'TRAPPIST-1b',
        surfaceType: 'volcanic',
        color: '#ea580c',
        secondaryColor: '#7c2d12',
        atmosphereColor: '#f97316',
        hasAtmosphere: true,
        radius: 1.42,
        distance: 14,
        orbitalSpeed: 1.85,
        eccentricity: 0.006,
        inclination: 0.5,
        axialTilt: 2.0,
        rotationSpeed: 0.8,
        hasRings: false,
        ringColor: '#fdba74',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.0,
        ringTilt: 0,
        moonCount: 0,
        massEarth: 1.37,
        meanTempK: 400,
        initialPhase: 0.2,
      },
      {
        id: 'trappist-d',
        name: 'TRAPPIST-1d',
        surfaceType: 'terrestrial',
        color: '#d97706',
        secondaryColor: '#78350f',
        atmosphereColor: '#fbbf24',
        hasAtmosphere: true,
        radius: 1.08,
        distance: 24,
        orbitalSpeed: 1.25,
        eccentricity: 0.008,
        inclination: 1.2,
        axialTilt: 8.5,
        rotationSpeed: 0.9,
        hasRings: false,
        ringColor: '#fcd34d',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.0,
        ringTilt: 0,
        moonCount: 0,
        massEarth: 0.388,
        meanTempK: 288,
        initialPhase: 1.7,
      },
      {
        id: 'trappist-e',
        name: 'TRAPPIST-1e',
        surfaceType: 'oceanic',
        color: '#0284c7',
        secondaryColor: '#15803d',
        atmosphereColor: '#38bdf8',
        hasAtmosphere: true,
        radius: 1.28,
        distance: 35,
        orbitalSpeed: 0.88,
        eccentricity: 0.005,
        inclination: 0.3,
        axialTilt: 14.0,
        rotationSpeed: 1.1,
        hasRings: false,
        ringColor: '#7dd3fc',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.1,
        ringTilt: 0,
        moonCount: 1,
        massEarth: 0.692,
        meanTempK: 251,
        initialPhase: 3.4,
      },
      {
        id: 'trappist-f',
        name: 'TRAPPIST-1f',
        surfaceType: 'ice_giant',
        color: '#38bdf8',
        secondaryColor: '#1e40af',
        atmosphereColor: '#93c5fd',
        hasAtmosphere: true,
        radius: 1.45,
        distance: 48,
        orbitalSpeed: 0.62,
        eccentricity: 0.01,
        inclination: 1.1,
        axialTilt: 19.0,
        rotationSpeed: 1.0,
        hasRings: true,
        ringColor: '#bae6fd',
        ringInnerRadius: 1.38,
        ringOuterRadius: 2.05,
        ringTilt: 15,
        moonCount: 1,
        massEarth: 1.039,
        meanTempK: 219,
        initialPhase: 4.8,
      },
      {
        id: 'trappist-h',
        name: 'TRAPPIST-1h',
        surfaceType: 'crystalline',
        color: '#a855f7',
        secondaryColor: '#4c1d95',
        atmosphereColor: '#d8b4fe',
        hasAtmosphere: false,
        radius: 1.05,
        distance: 63,
        orbitalSpeed: 0.42,
        eccentricity: 0.025,
        inclination: 2.4,
        axialTilt: 11.0,
        rotationSpeed: 0.7,
        hasRings: false,
        ringColor: '#e9d5ff',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.0,
        ringTilt: 0,
        moonCount: 0,
        massEarth: 0.326,
        meanTempK: 173,
        initialPhase: 5.9,
      },
    ],
  },
  {
    id: 'hyperion-giants',
    name: 'Hyperion Ringed Giants & Eccentric Comets',
    description: 'High-luminosity blue-white A-type star orbited by ringed super-Jupiters and high-eccentricity worlds.',
    star: {
      name: 'Hyperion Prime',
      spectralType: 'A1V Blue-White Star',
      color: '#e0f2fe',
      coronaColor: '#06b6d4',
      intensity: 2.1,
      radius: 7.4,
      temperatureK: 9200,
    },
    planets: [
      {
        id: 'vulcan-prime',
        name: 'Pyros',
        surfaceType: 'volcanic',
        color: '#f97316',
        secondaryColor: '#450a0a',
        atmosphereColor: '#ef4444',
        hasAtmosphere: true,
        radius: 1.45,
        distance: 20,
        orbitalSpeed: 1.15,
        eccentricity: 0.28,
        inclination: 12.0,
        axialTilt: 32.0,
        rotationSpeed: 1.8,
        hasRings: false,
        ringColor: '#fca5a5',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.0,
        ringTilt: 0,
        moonCount: 1,
        massEarth: 2.8,
        meanTempK: 980,
        initialPhase: 0.8,
      },
      {
        id: 'aether-ring',
        name: 'Aetherius',
        surfaceType: 'gas_giant',
        color: '#38bdf8',
        secondaryColor: '#1e3a8a',
        atmosphereColor: '#7dd3fc',
        hasAtmosphere: true,
        radius: 3.5,
        distance: 52,
        orbitalSpeed: 0.52,
        eccentricity: 0.08,
        inclination: 4.5,
        axialTilt: 28.0,
        rotationSpeed: 2.8,
        hasRings: true,
        ringColor: '#7dd3fc',
        ringInnerRadius: 1.35,
        ringOuterRadius: 2.55,
        ringTilt: 24.0,
        moonCount: 4,
        massEarth: 420.0,
        meanTempK: 290,
        initialPhase: 2.4,
      },
      {
        id: 'chronos',
        name: 'Chronos',
        surfaceType: 'crystalline',
        color: '#c084fc',
        secondaryColor: '#581c87',
        atmosphereColor: '#e879f9',
        hasAtmosphere: true,
        radius: 2.4,
        distance: 88,
        orbitalSpeed: 0.29,
        eccentricity: 0.35,
        inclination: -16.5,
        axialTilt: 42.0,
        rotationSpeed: 1.9,
        hasRings: true,
        ringColor: '#f0abfc',
        ringInnerRadius: 1.4,
        ringOuterRadius: 2.3,
        ringTilt: -30.0,
        moonCount: 3,
        massEarth: 64.0,
        meanTempK: 185,
        initialPhase: 4.2,
      },
    ],
  },
];
