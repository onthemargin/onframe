import { describe, it, expect } from 'vitest';
import { synthesize } from '../synthesizer.js';

// ---------------------------------------------------------------------------
// Helper: a "good portrait" baseline — all metrics in the sweet spot.
// Individual tests override specific fields to exercise scoring branches.
// ---------------------------------------------------------------------------
function goodMetrics(overrides = {}) {
  return {
    faceDetected: true,
    // Lighting
    hasCatchlights: true,
    catchlightClockHour: 11,       // 10-2 o'clock sweet spot
    lightingPattern: 'loop',
    lightingRatio: 2.5,            // 1.3-5.0 range
    lightingBroadShort: 'short',
    isGreenCast: false,
    isCoolCast: false,
    exposureEV: 0.0,
    skinSmoothness: 0.50,
    // Head pose (radians)
    faceYawAngle: 0.35,            // ~20 deg — classic 3/4
    facePitchAngle: 0.0,
    faceRollAngle: 0.0,
    viewTypeName: 'Classic 3/4',
    // Composition
    eyelineYPosition: 0.33,
    faceFramingRatio: 0.30,
    horizontalOffset: 0.1,
    headroomRatio: 0.10,
    cropLineSafety: 'safe',
    leadRoomViolation: false,
    // Sharpness
    faceQualityScore: 0.85,
    nearEyeSharpness: 0.80,
    // Background
    backgroundBrightness: 0.20,
    // Eye contact
    isWideEyed: false,
    inferiorScleralShow: 0.05,
    isSquinching: true,
    isDuchenneSmile: true,
    isSmiling: true,
    // Subject isolation & tonal range
    subjectIsolationRatio: 2.0,
    highlightClipPct: 0.01,
    shadowClipPct: 0.02,
    // Expression tension
    browTension: 0.1,
    jawTension: 0.1,
    hasTension: false,
    // Body pose
    hasPose: false,
    shoulderTiltDeg: 0,
    shouldersSquare: false,
    bodyCropSafety: 'safe',
    kneesVisible: false,
    anklesVisible: false,
    ...overrides,
  };
}

// =========================================================================
// No-face detection
// =========================================================================
describe('synthesize — no face detected', () => {
  it('returns score 0 and a detection card when no face is found', () => {
    const result = synthesize({ faceDetected: false });
    expect(result.overallScore).toBe(0);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].category).toBe('Detection');
    expect(result.cards[0].score).toBe(0);
  });
});

// =========================================================================
// Overall structure
// =========================================================================
describe('synthesize — good portrait baseline', () => {
  it('returns 6 cards, a positive overall score, photoType, and summary', () => {
    const result = synthesize(goodMetrics());
    expect(result.cards).toHaveLength(6);
    expect(result.overallScore).toBeGreaterThan(60);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(result.photoType).toEqual({ type: 'head-and-shoulders', label: 'Head & shoulders' });
    expect(typeof result.summary).toBe('string');
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it('summary mentions strongest and weakest areas', () => {
    // With poor lighting (no catchlights, flat) but good everything else
    const result = synthesize(goodMetrics({ hasCatchlights: false, lightingRatio: 1.0 }));
    expect(result.summary.toLowerCase()).toContain('lighting');
  });

  it('cards have correct categories in order', () => {
    const result = synthesize(goodMetrics());
    const categories = result.cards.map(c => c.category);
    expect(categories).toEqual([
      'Lighting',
      'Head Angle & Pose',
      'Composition & Framing',
      'Sharpness & Focus',
      'Background',
      'Eye Contact & Gaze',
    ]);
  });

  it('each card has required fields', () => {
    const result = synthesize(goodMetrics());
    for (const card of result.cards) {
      expect(card).toHaveProperty('category');
      expect(card).toHaveProperty('score');
      expect(card).toHaveProperty('title');
      expect(card).toHaveProperty('tip');
      expect(card).toHaveProperty('priority');
      expect(card).toHaveProperty('gearNeeded');
      expect(Array.isArray(card.gearNeeded)).toBe(true);
      expect(typeof card.score).toBe('number');
      expect(card.score).toBeGreaterThanOrEqual(0);
      expect(card.score).toBeLessThanOrEqual(100);
    }
  });

  it('overall score is weighted average of card scores', () => {
    const result = synthesize(goodMetrics());
    const weights = [0.30, 0.25, 0.20, 0.15, 0.05, 0.05];
    const expected = Math.round(
      result.cards.reduce((sum, c, i) => sum + c.score * weights[i], 0)
    );
    expect(result.overallScore).toBe(expected);
  });
});

// =========================================================================
// Lighting scoring
// =========================================================================
describe('scoreLighting (via synthesize)', () => {
  function lightingScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[0];
  }

  it('penalizes missing catchlights', () => {
    const withCatch = lightingScore({ hasCatchlights: true });
    const withoutCatch = lightingScore({ hasCatchlights: false });
    expect(withoutCatch.score).toBeLessThan(withCatch.score);
    expect(withoutCatch.tip).toContain('catchlight');
  });

  it('rewards catchlight in 10-2 zone', () => {
    const card = lightingScore({ catchlightClockHour: 11 });
    expect(card.tip).toContain("nailed it");
  });

  it('penalizes catchlight at 3 or 9 o\'clock', () => {
    const card = lightingScore({ catchlightClockHour: 3 });
    expect(card.tip).toContain("coming in from the side");
  });

  it('penalizes flat lighting ratio (< 1.3)', () => {
    const flat = lightingScore({ lightingRatio: 1.1 });
    const normal = lightingScore({ lightingRatio: 2.5 });
    expect(flat.score).toBeLessThan(normal.score);
    expect(flat.tip).toContain('Both sides of the face are lit the same');
  });

  it('penalizes harsh lighting ratio (> 5.0)', () => {
    const harsh = lightingScore({ lightingRatio: 7.0 });
    expect(harsh.tip).toContain('One side of the face is much darker');
  });

  it('penalizes broad lighting', () => {
    const broad = lightingScore({ lightingBroadShort: 'broad' });
    const short = lightingScore({ lightingBroadShort: 'short' });
    expect(broad.score).toBeLessThan(short.score);
    expect(broad.tip).toContain('Broad lighting');
  });

  it('penalizes green cast', () => {
    const card = lightingScore({ isGreenCast: true });
    expect(card.tip).toContain('Green color cast');
  });

  it('penalizes cool cast', () => {
    const card = lightingScore({ isCoolCast: true });
    expect(card.tip).toContain('blue/cool tone');
  });

  it('penalizes underexposure (EV < -1.5)', () => {
    const card = lightingScore({ exposureEV: -2.0 });
    expect(card.tip).toContain('underexposed');
  });

  it('penalizes overexposure (EV > 1.5)', () => {
    const card = lightingScore({ exposureEV: 2.0 });
    expect(card.tip).toContain('overexposed');
  });

  it('penalizes very low skin smoothness (< 0.20)', () => {
    const card = lightingScore({ skinSmoothness: 0.10 });
    expect(card.tip).toContain('Hard light');
  });

  it('penalizes moderate skin smoothness (0.20-0.35)', () => {
    const card = lightingScore({ skinSmoothness: 0.25 });
    expect(card.tip).toContain('Moderate skin texture');
  });

  it('sets priority 1 when score is below 55', () => {
    // Stack multiple penalties to drive score below 55
    const card = lightingScore({
      hasCatchlights: false,
      lightingRatio: 7.0,
      exposureEV: -2.0,
      skinSmoothness: 0.10,
    });
    expect(card.score).toBeLessThan(55);
    expect(card.priority).toBe(1);
    expect(card.title).toBe('Lighting is the main issue');
  });

  it('clamps score to 0-100 range', () => {
    // Stack every possible penalty
    const card = lightingScore({
      hasCatchlights: false,
      lightingRatio: 7.0,
      lightingBroadShort: 'broad',
      isGreenCast: true,
      exposureEV: -2.0,
      skinSmoothness: 0.10,
    });
    expect(card.score).toBeGreaterThanOrEqual(0);
    expect(card.score).toBeLessThanOrEqual(100);
  });
});

// =========================================================================
// Head pose scoring
// =========================================================================
describe('scoreHeadPose (via synthesize)', () => {
  function poseScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[1];
  }

  it('penalizes full frontal (yaw < 5 deg)', () => {
    const card = poseScore({ faceYawAngle: 0.02, viewTypeName: 'Full frontal' });
    expect(card.tip).toContain('passport pose');
  });

  it('likes classic 3/4 view (15-30 deg)', () => {
    // ~20 degrees in radians
    const card = poseScore({ faceYawAngle: 0.35, viewTypeName: 'Classic 3/4' });
    expect(card.tip).toContain('most flattering');
  });

  it('penalizes extreme turn (> 45 deg)', () => {
    const card = poseScore({ faceYawAngle: 1.0, viewTypeName: 'Strong turn' });
    expect(card.tip).toContain('turned too far');
  });

  it('penalizes chin raised too high (pitch < -15 deg)', () => {
    // -20 deg in radians
    const card = poseScore({ facePitchAngle: -0.40 });
    expect(card.tip).toContain('Chin is raised too high');
  });

  it('penalizes chin tucked down (pitch > 18 deg)', () => {
    // 22 deg in radians
    const card = poseScore({ facePitchAngle: 0.38 });
    expect(card.tip).toContain('Chin is tucked down');
  });

  it('penalizes excessive head tilt (roll > 12 deg)', () => {
    // 15 deg in radians
    const card = poseScore({ faceRollAngle: 0.30 });
    expect(card.tip).toContain('Head tilt');
  });

  it('never requires gear', () => {
    const card = poseScore({});
    expect(card.gearNeeded).toEqual([]);
  });
});

// =========================================================================
// Composition scoring
// =========================================================================
describe('scoreComposition (via synthesize)', () => {
  function compScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[2];
  }

  it('penalizes eyes too low (eyelineYPosition > 0.55)', () => {
    const card = compScore({ eyelineYPosition: 0.65 });
    expect(card.tip).toContain('Eyes are too low');
  });

  it('penalizes eyes too high (eyelineYPosition < 0.20)', () => {
    const card = compScore({ eyelineYPosition: 0.15 });
    expect(card.tip).toContain('Eyes are very high');
  });

  it('penalizes very small subject in full-length shot', () => {
    const card = compScore({ faceFramingRatio: 0.005 });
    expect(card.tip).toContain('very small in the frame');
  });

  it('penalizes face too large in closeup (> 75%)', () => {
    const card = compScore({ faceFramingRatio: 0.85 });
    expect(card.tip).toContain('fills almost the entire image');
  });

  it('penalizes large horizontal offset', () => {
    const card = compScore({ horizontalOffset: 0.7 });
    expect(card.tip).toContain('offset');
  });

  it('penalizes clipped crown (headroom < 0.04)', () => {
    const card = compScore({ headroomRatio: 0.02 });
    expect(card.tip).toContain('Crown is clipped');
  });

  it('penalizes excessive headroom (> 0.22)', () => {
    const card = compScore({ headroomRatio: 0.35 });
    expect(card.tip).toContain('Excessive headroom');
  });

  it('penalizes chin-clipped crop', () => {
    const card = compScore({ cropLineSafety: 'chin-clipped' });
    expect(card.tip).toContain('chin is clipped');
  });

  it('penalizes chin-neck crop', () => {
    const card = compScore({ cropLineSafety: 'chin-neck-crop' });
    expect(card.tip).toContain('cuts at the neck');
  });

  it('penalizes shoulder crop', () => {
    const card = compScore({ cropLineSafety: 'shoulder-crop' });
    expect(card.tip).toContain('mid-shoulder');
  });

  it('penalizes lead room violation', () => {
    const card = compScore({ leadRoomViolation: true });
    expect(card.tip).toContain('lead room');
  });

  it('penalizes knee crop from body pose', () => {
    const card = compScore({ bodyCropSafety: 'knee-crop' });
    expect(card.tip).toContain('cuts right at the knees');
  });

  it('penalizes ankle crop from body pose', () => {
    const card = compScore({ bodyCropSafety: 'ankle-crop' });
    expect(card.tip).toContain('feet are cut off');
  });

  it('penalizes wrist crop from body pose', () => {
    const card = compScore({ bodyCropSafety: 'wrist-crop' });
    expect(card.tip).toContain('hands are clipped');
  });

  it('penalizes square shoulders in wider shots', () => {
    // half-length shot with square shoulders
    const card = compScore({ faceFramingRatio: 0.10, hasPose: true, shouldersSquare: true });
    expect(card.tip).toContain('shoulders are square');
  });

  it('never requires gear', () => {
    const card = compScore({});
    expect(card.gearNeeded).toEqual([]);
  });
});

// =========================================================================
// Sharpness scoring
// =========================================================================
describe('scoreSharpness (via synthesize)', () => {
  function sharpScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[3];
  }

  it('scores based on combined face and eye sharpness', () => {
    const card = sharpScore({ faceQualityScore: 0.90 });
    expect(card.score).toBeGreaterThanOrEqual(75);
  });

  it('warns about significant blur (< 0.25)', () => {
    const card = sharpScore({
      faceQualityScore: 0.20,
      faceYawAngle: 0.0,
      leftEyeSharpness: 0.2,
      rightEyeSharpness: 0.2,
      nearEyeSharpness: 0.20,
    });
    expect(card.tip).toContain('significantly blurry');
    expect(card.score).toBeLessThan(30);
  });

  it('warns about soft focus (0.25-0.50)', () => {
    const card = sharpScore({
      faceQualityScore: 0.40,
      faceYawAngle: 0.0,
      leftEyeSharpness: 0.4,
      rightEyeSharpness: 0.4,
      nearEyeSharpness: 0.40,
    });
    expect(card.tip).toContain('soft focus');
  });

  it('does not over-penalize when both eyes are sharp in a frontal portrait', () => {
    const card = sharpScore({
      faceQualityScore: 0.45,
      faceYawAngle: 0.0,
      leftEyeSharpness: 1.0,
      rightEyeSharpness: 0.95,
      nearEyeSharpness: 1.0,
    });
    expect(card.score).toBeGreaterThanOrEqual(70);
  });

  it('penalizes a soft eye when the portrait is frontal', () => {
    const card = sharpScore({
      faceQualityScore: 0.55,
      faceYawAngle: 0.0,
      leftEyeSharpness: 1.0,
      rightEyeSharpness: 0.2,
      nearEyeSharpness: 1.0,
    });
    expect(card.score).toBeLessThan(60);
  });

  it('penalizes low near-eye sharpness in turned poses', () => {
    // Yaw > 15 deg (~0.27 rad) and low near-eye sharpness
    const card = sharpScore({
      faceYawAngle: 0.35,
      nearEyeSharpness: 0.30,
      faceQualityScore: 0.70,
    });
    expect(card.tip).toContain('near eye');
  });

  it('requires gear when score is below 50', () => {
    const card = sharpScore({ faceQualityScore: 0.15, nearEyeSharpness: 0.80 });
    expect(card.score).toBeLessThan(50);
    expect(card.gearNeeded).toContain('tripod');
  });
});

// =========================================================================
// Background scoring
// =========================================================================
describe('scoreBackground (via synthesize)', () => {
  function bgScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[4];
  }

  it('penalizes very bright background (> 0.80)', () => {
    const card = bgScore({ backgroundBrightness: 0.90 });
    expect(card.score).toBeLessThan(65);
    expect(card.tip).toContain('very bright');
  });

  it('rewards dark background (< 0.10)', () => {
    const card = bgScore({ backgroundBrightness: 0.05 });
    expect(card.score).toBeGreaterThanOrEqual(75);
    expect(card.tip).toContain('Dark background');
  });

  it('gives a positive default tip for a neutral background (never empty)', () => {
    const card = bgScore({ backgroundBrightness: 0.20 });
    // Card text in the UI is `aiReason || tip`; an empty tip + no aiReason
    // would render an empty card. Background must always emit a non-empty tip.
    expect(card.tip.length).toBeGreaterThan(0);
    expect(card.tip).toMatch(/background/i);
    expect(card.score).toBeGreaterThanOrEqual(75);
  });

  it('rewards strong subject isolation (ratio > 3) with higher score', () => {
    const card = bgScore({ subjectIsolationRatio: 4.0 });
    expect(card.score).toBeGreaterThanOrEqual(75);
  });

  it('penalizes no subject isolation (ratio < 1.5)', () => {
    const card = bgScore({ subjectIsolationRatio: 1.2 });
    expect(card.tip).toContain('Portrait Mode');
  });

  it('clamps score to 0-100', () => {
    const card = bgScore({ backgroundBrightness: 0.05 });
    expect(card.score).toBeLessThanOrEqual(100);
    expect(card.score).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// Eye contact scoring
// =========================================================================
describe('scoreEyeContact (via synthesize)', () => {
  function eyeScore(overrides) {
    return synthesize(goodMetrics(overrides)).cards[5];
  }

  it('penalizes wide-eyed expression', () => {
    const card = eyeScore({ isWideEyed: true, isSquinching: false });
    expect(card.tip).toContain('wide open');
  });

  it('penalizes inferior scleral show when > threshold and not squinching', () => {
    const card = eyeScore({ inferiorScleralShow: 0.35, isSquinching: false });
    expect(card.tip).toContain('white showing below');
  });

  it('rewards squinching', () => {
    const withSquinch = eyeScore({ isSquinching: true });
    const without = eyeScore({ isSquinching: false });
    expect(withSquinch.score).toBeGreaterThan(without.score);
    expect(withSquinch.tip).toContain('lower-lid lift');
  });

  it('rewards Duchenne smile', () => {
    const duchenne = eyeScore({ isDuchenneSmile: true });
    const posed = eyeScore({ isDuchenneSmile: false, isSmiling: true });
    expect(duchenne.score).toBeGreaterThan(posed.score);
    expect(duchenne.tip).toContain('genuine smile');
  });

  it('notes posed smile (smiling but not Duchenne)', () => {
    const card = eyeScore({ isSmiling: true, isDuchenneSmile: false, isSquinching: false });
    expect(card.tip).toContain('posed');
  });

  it('penalizes brow tension', () => {
    const card = eyeScore({ browTension: 0.5 });
    expect(card.tip).toContain('forehead looks a bit tense');
  });

  it('penalizes jaw tension', () => {
    const card = eyeScore({ jawTension: 0.5 });
    expect(card.tip).toContain('jaw looks tight');
  });

  it('never requires gear', () => {
    const card = eyeScore({});
    expect(card.gearNeeded).toEqual([]);
  });

  it('suppresses scleral-show tip when already squinching', () => {
    const card = eyeScore({ inferiorScleralShow: 0.25, isSquinching: true });
    expect(card.tip).not.toContain('white showing below');
    expect(card.tip).toContain('lower-lid lift');
  });
});
