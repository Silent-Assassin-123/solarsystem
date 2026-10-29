import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateOrbitalPosition,
  calculateInstantaneousAngularSpeed,
  generateOrbitPoints,
  computePlanetTelemetry,
  createNewPlanet,
  validateSystemConfig,
  DEFAULT_SOLAR_SYSTEM,
} from './solarMath';

test('calculateOrbitalPosition computes accurate circular orbit coordinates', () => {
  const pos0 = calculateOrbitalPosition(
    { distance: 30, eccentricity: 0, inclination: 0, initialPhase: 0 },
    0
  );
  assert.ok(Math.abs(pos0.x - 30) < 1e-6);
  assert.ok(Math.abs(pos0.y) < 1e-6);
  assert.ok(Math.abs(pos0.z) < 1e-6);

  const posHalfPi = calculateOrbitalPosition(
    { distance: 30, eccentricity: 0, inclination: 0, initialPhase: 0 },
    Math.PI / 2
  );
  assert.ok(Math.abs(posHalfPi.x) < 1e-6);
  assert.ok(Math.abs(posHalfPi.z - 30) < 1e-6);
});

test('calculateOrbitalPosition respects eccentricity (perihelion < aphelion) and inclination', () => {
  const planet = { distance: 50, eccentricity: 0.2, inclination: 30, initialPhase: 0 };
  // At angle = 0 (perihelion), r = a(1 - e) = 50 * 0.8 = 40
  const perihelion = calculateOrbitalPosition(planet, 0);
  assert.ok(Math.abs(perihelion.x - 40) < 1e-5);

  // At angle = PI (aphelion), r = a(1 + e) = 50 * 1.2 = 60
  const aphelion = calculateOrbitalPosition(planet, Math.PI);
  assert.ok(Math.abs(aphelion.x - -60) < 1e-5);

  // At angle = PI/2, y elevation is non-zero due to 30 deg inclination
  const quarter = calculateOrbitalPosition(planet, Math.PI / 2);
  assert.ok(quarter.y > 15);
});

test('calculateInstantaneousAngularSpeed increases at perihelion vs aphelion (Kepler 2nd law)', () => {
  const planet = { distance: 40, eccentricity: 0.3, orbitalSpeed: 1.0, initialPhase: 0 };
  const speedPeri = calculateInstantaneousAngularSpeed(planet, 0);
  const speedAphe = calculateInstantaneousAngularSpeed(planet, Math.PI);
  assert.ok(speedPeri > speedAphe);
});

test('generateOrbitPoints creates a closed loop of points', () => {
  const planet = DEFAULT_SOLAR_SYSTEM.planets[2]; // Earth
  const pts = generateOrbitPoints(planet, 64);
  assert.equal(pts.length, 65);
  assert.ok(Math.abs(pts[0].x - pts[64].x) < 1e-5);
  assert.ok(Math.abs(pts[0].z - pts[64].z) < 1e-5);
});

test('computePlanetTelemetry returns expected Earth baseline metrics', () => {
  const earth = DEFAULT_SOLAR_SYSTEM.planets.find((p) => p.id === 'earth')!;
  const telemetry = computePlanetTelemetry(earth, 5778);
  assert.equal(telemetry.semiMajorAU, 1);
  assert.equal(telemetry.orbitalPeriodDays, 365);
  assert.ok(Math.abs(telemetry.gravityMs2 - 9.81) < 0.05);
});

test('createNewPlanet places new planet beyond outermost orbit and validateSystemConfig sanitizes input', () => {
  const added = createNewPlanet(DEFAULT_SOLAR_SYSTEM.planets, {
    name: 'Kepler-452b',
    surfaceType: 'oceanic',
    hasRings: true,
  });
  assert.equal(added.name, 'Kepler-452b');
  assert.equal(added.hasRings, true);
  assert.ok(added.distance > 142);

  const validated = validateSystemConfig({
    name: 'Test Custom System',
    planets: [added],
  });
  assert.ok(validated !== null);
  assert.equal(validated!.name, 'Test Custom System');
  assert.equal(validated!.planets.length, 1);
  assert.equal(validated!.planets[0].name, 'Kepler-452b');

  assert.equal(validateSystemConfig(null), null);
  assert.equal(validateSystemConfig({ name: 'Empty', planets: [] }), null);
});
