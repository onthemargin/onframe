/**
 * synthesizer.js — Rules-based portrait coaching
 * Port of iOS FeedbackSynthesizer.swift, enhanced with §1.14 research signals.
 */

import { classifyPhotoType } from './composition.js';

const CATEGORIES = [
  { id: 'lighting',    label: 'Lighting',             weight: 0.30 },
  { id: 'headpose',    label: 'Head Angle & Pose',    weight: 0.25 },
  { id: 'composition', label: 'Composition & Framing',weight: 0.20 },
  { id: 'sharpness',   label: 'Sharpness & Focus',    weight: 0.15 },
  { id: 'background',  label: 'Background',           weight: 0.05 },
  { id: 'eyecontact',  label: 'Eye Contact & Gaze',   weight: 0.05 },
];

export function synthesize(m) {
  if (!m.faceDetected) {
    return {
      cards: [{
        category: 'Detection',
        score: 0,
        title: 'No face found',
        tip: 'We couldn\'t find a face in this photo. Try again with a different photo — make sure the face is well-lit, facing the camera, and not too far away.',
        priority: 1,
        gearNeeded: [],
      }],
      overallScore: 0,
    };
  }

  const photoType = classifyPhotoType(m.faceFramingRatio);

  const cards = [
    scoreLighting(m),
    scoreHeadPose(m, photoType),
    scoreComposition(m, photoType),
    scoreSharpness(m),
    scoreBackground(m),
    scoreEyeContact(m),
  ];

  const overallScore = Math.round(
    cards.reduce((sum, c, i) => sum + c.score * CATEGORIES[i].weight, 0)
  );

  const rawSummary = generateSummary(cards, overallScore);
  const summary = rawSummary.charAt(0).toUpperCase() + rawSummary.slice(1);

  return { cards, overallScore, photoType, summary };
}

// ─── Lighting ────────────────────────────────────────────────────────────────

function scoreLighting(m) {
  let score = 75;
  const tips = [];
  const gear = new Set();

  // Catchlight (skip if sunglasses detected)
  if (m.eyesObscured) {
    tips.push('Eyes appear to be covered (sunglasses or dark glasses) — we can\'t assess catchlights or eye expression in this photo.');
  } else if (!m.hasCatchlights) {
    score -= 20;
    tips.push('No catchlight in the eyes — they look flat and lifeless. Turn toward a light source (a window, the sky, or a lamp) so you can see a little reflection in the eyes. That tiny spark is what makes a portrait feel alive.');
    gear.add('reflector');
  } else {
    if (m.catchlightClockHour >= 10 || m.catchlightClockHour <= 2) {
      score += 5;
      tips.push('Nice catchlight in the eyes — the light is coming from slightly above, which is the sweet spot. You nailed it.');
    } else {
      score -= 5;
      tips.push('There\'s a catchlight but it\'s coming in from the side. Turn your face so the main light (window, sun, or lamp) is slightly in front of you and above — you want the reflection near the top of each eye, like at 10 o\'clock or 2 o\'clock.');
    }
  }

  // Lighting ratio
  if (m.lightingRatio < 1.15) {
    score -= 10;
    tips.push('Both sides of the face are lit the same, so it looks a bit flat. Turn slightly so the light hits one side more than the other — that gentle shadow adds shape and dimension.');
  } else if (m.lightingRatio > 5.0) {
    score -= 20;
    tips.push('One side of the face is much darker than the other. Outdoors, turn toward the light or step into open shade. Indoors, bounce light onto the shadow side with a white wall or sheet.');
    gear.add('reflector');
  }

  // Broad vs short
  if (m.lightingBroadShort === 'broad') {
    score -= 10;
    tips.push('Broad lighting — the lit side of the face is the one facing the camera, which makes the face look wider. Try turning your face slightly toward the light instead; the shadow side ends up toward the camera, which is more flattering for most people.');
  }

  // Green cast
  if (m.isGreenCast) {
    score -= 10;
    tips.push('Green color cast on the skin — this usually comes from fluorescent lights or mixed lighting and it makes skin look a little off. Try shooting by a window or outdoors instead.');
    gear.add('daylight LED panel');
  } else if (m.isCoolCast) {
    score -= 5;
    tips.push('The photo has a blue/cool tone — the light is a bit cold. Try shooting near a window with natural light, during golden hour (the hour before sunset), or under a warmer lamp.');
  }

  // Exposure
  if (m.exposureEV < -1.8) {
    score -= 15;
    tips.push('The photo is underexposed — the face is too dark. Move closer to a window or light source, or brighten the exposure on your camera/phone.');
  } else if (m.exposureEV > 1.8) {
    score -= 15;
    tips.push('The photo is overexposed — the bright areas are blown out. Step back from the light, shoot in the shade, or soften direct sun with a sheer curtain.');
    gear.add('diffuser');
  }

  // Skin smoothness — only flag as a lighting problem when the lighting
  // ratio also confirms harsh shadows. A low smoothness value alone often
  // just means facial hair or stray hair, not bad light.
  if (m.skinSmoothness < 0.20 && m.lightingRatio > 2.0) {
    score -= 15;
    tips.push('Hard light is creating harsh shadows on the skin. Soft, large light sources are much more flattering — shoot in open shade, next to a big window, or on an overcast day.');
    gear.add('softbox');
  } else if (m.skinSmoothness < 0.35 && m.lightingRatio > 1.8) {
    score -= 8;
    tips.push('Moderate skin texture and shadows — the light could be softer. Move closer to a large window, or diffuse the main light with a sheer curtain or softbox.');
    gear.add('softbox');
  }

  // Face tonal clipping
  if (m.highlightClipPct > 0.05) {
    score -= 10;
    tips.push('Parts of the face are blown out — bright areas have lost detail. Tap the face on screen to set exposure, or move away from direct light.');
  }
  if (m.shadowClipPct > 0.08) {
    score -= 8;
    tips.push('Parts of the face are lost in shadow — dark areas have no detail. Turn toward the light or use the flash as a fill.');
  }

  score = clamp(score);
  const allTips = tips.join(' ');

  return {
    category: 'Lighting',
    score,
    title: score >= 75 ? 'Well-lit portrait' : score >= 55 ? 'Lighting needs refinement' : 'Lighting is the main issue',
    tip: allTips || 'Lighting looks balanced for this portrait.',
    priority: score < 55 ? 1 : score < 75 ? 2 : 3,
    gearNeeded: [...gear],
  };
}

// ─── Head pose ───────────────────────────────────────────────────────────────

function scoreHeadPose(m, photoType) {
  let score = 80;
  const tips = [];
  const pt = photoType.type;

  const yawDeg   = m.faceYawAngle   * 180 / Math.PI;
  const pitchDeg = m.facePitchAngle * 180 / Math.PI;
  const rollDeg  = m.faceRollAngle  * 180 / Math.PI;
  const absYaw = Math.abs(yawDeg);
  const vName = m.viewTypeName;

  // Yaw
  if (absYaw < 5) {
    score -= 15;
    tips.push('Straight-on passport pose — turning the face just slightly to one side adds depth and is more flattering for most people.');
  } else if (absYaw < 15) {
    tips.push('Slight turn — try rotating a little more to bring out the cheekbones.');
  } else if (absYaw >= 15 && absYaw < 30) {
    tips.push('Classic 3/4 angle — the most flattering pose for most faces. Well done.');
  } else if (absYaw >= 30 && absYaw < 45) {
    tips.push('Strong turn — works well for a dramatic or editorial look. For a more conventional headshot, turn back a little toward the camera.');
  } else {
    score -= 25;
    tips.push('Face is turned too far — one eye is mostly hidden and the portrait loses connection. Turn back toward the camera a bit.');
  }

  // Pitch (chin up/down) — for wider shots, even mild chin-up signals a high camera angle
  const isWideShot = pt === 'three-quarter' || pt === 'full-length' || pt === 'half-length';
  if (isWideShot && pitchDeg < -8) {
    score -= 15;
    tips.push('The camera looks like it\'s above you — this makes legs look short and the head look too big. Lower the camera to waist or chest height for a more flattering perspective.');
  } else if (pitchDeg < -18) {
    score -= 20;
    tips.push('Chin is raised too high — it shows the underside of the nose and isn\'t flattering. Bring your forehead gently forward and down to level the chin.');
  } else if (pitchDeg > 18) {
    score -= 15;
    tips.push('Chin is tucked down too far, which can create a double-chin effect. Extend your chin slightly forward and down — it feels a little weird but it looks much better.');
  }

  // Roll
  if (Math.abs(rollDeg) > 12) {
    score -= 10;
    tips.push('Head tilt is pretty strong — a subtle tilt adds character, but too much can make the shot feel off-balance. Level the head, or straighten the camera.');
  }

  score = clamp(score);
  return {
    category: 'Head Angle & Pose',
    score,
    title: score >= 75 ? `Good pose — ${vName}` : score >= 55 ? 'Pose could be more flattering' : 'Pose needs significant adjustment',
    tip: tips.join(' ') || 'Head angle and pose look good.',
    priority: score < 55 ? 1 : score < 75 ? 2 : 3,
    gearNeeded: [],
  };
}

// ─── Composition ──────────────────────────────────────────────────────────────

function scoreComposition(m, photoType) {
  let score = 80;
  const tips = [];
  const pt = photoType.type;

  // Eyeline vertical position — looser for wider shots
  const eyeHighThreshold = (pt === 'half-length' || pt === 'three-quarter' || pt === 'full-length') ? 0.12 : 0.20;
  const eyeLowThreshold  = (pt === 'half-length' || pt === 'three-quarter' || pt === 'full-length') ? 0.40 : 0.55;

  if (m.eyelineYPosition > eyeLowThreshold) {
    score -= 20;
    tips.push('Eyes are too low in the frame — there\'s a lot of empty space above the head. Reframe so the eyes sit higher in the frame.');
  } else if (m.eyelineYPosition < eyeHighThreshold) {
    score -= 15;
    tips.push('Eyes are very high in the frame, which makes the shot feel top-heavy. Move the camera down or step back a bit.');
  }

  // Face size — only penalize if it doesn't match the detected type
  if (pt === 'closeup' && m.faceFramingRatio > 0.75) {
    score -= 15;
    tips.push('The face fills almost the entire image — pull back a little so there\'s breathing room around the head.');
  } else if ((pt === 'full-length' || pt === 'three-quarter') && m.faceFramingRatio < 0.01) {
    score -= 10;
    tips.push('The subject is very small in the frame. Move closer or zoom in so the person stands out more.');
  }

  // Horizontal centering
  if (Math.abs(m.horizontalOffset) > 0.5) {
    score -= 10;
    tips.push('Face is offset noticeably to one side. That can be an intentional style, but if you\'re also looking toward that same edge, the shot feels cramped. Leave more space in the direction you\'re facing.');
  }

  // Headroom — wider shots naturally have more headroom
  const headroomMax = (pt === 'half-length' || pt === 'three-quarter' || pt === 'full-length') ? 0.45 : 0.30;
  if (m.headroomRatio < 0.04 && (pt === 'closeup' || pt === 'head-and-shoulders')) {
    score -= 15;
    tips.push('Crown is clipped — the very top of the head is cut off. Leave a little space above the hair.');
  } else if (m.headroomRatio > headroomMax) {
    score -= 10;
    tips.push('Excessive headroom — there\'s a lot of empty space above the head. Crop tighter or reframe.');
  }

  // Crop safety — context-dependent
  if (m.cropLineSafety === 'chin-clipped') {
    score -= 15;
    tips.push('The chin is clipped by the bottom of the frame — this is one of the most awkward crops. Either crop tighter (mid-forehead to mid-chin) or looser (down to the chest).');
  } else if (m.cropLineSafety === 'chin-neck-crop' && pt !== 'closeup') {
    score -= 12;
    tips.push('The frame cuts at the neck, which feels uncomfortable. Crop either above the chin or below the shoulders instead.');
  } else if (m.cropLineSafety === 'shoulder-crop' && (pt === 'half-length' || pt === 'three-quarter' || pt === 'full-length')) {
    // Shoulder crop is fine for wider shots — don't penalize
  } else if (m.cropLineSafety === 'shoulder-crop') {
    score -= 8;
    tips.push('The frame cuts mid-shoulder, which looks a bit awkward. Frame from the chest up, or pull back to include the waist.');
  }

  // Lead room
  if (m.leadRoomViolation) {
    score -= 5;
    tips.push('You\'re looking toward the edge of the frame without much lead room — it feels like you\'re looking into a wall. Leave more space in the direction you\'re looking.');
  }

  // Body crop safety (from PoseLandmarker)
  if (m.bodyCropSafety === 'knee-crop') {
    score -= 15;
    tips.push('The frame cuts right at the knees — one of the most awkward crops. Crop at mid-thigh or go full-length instead.');
  } else if (m.bodyCropSafety === 'ankle-crop') {
    score -= 12;
    tips.push('The feet are cut off at the ankles. Include the full feet with a small margin below, or crop higher at mid-calf.');
  } else if (m.bodyCropSafety === 'wrist-crop') {
    score -= 8;
    tips.push('The hands are clipped at the edge of the frame. Either bring them fully into the shot or crop above them entirely.');
  }

  // Shoulders square (for wider shots)
  if (m.hasPose && m.shouldersSquare && (pt === 'half-length' || pt === 'three-quarter' || pt === 'full-length')) {
    score -= 5;
    tips.push('Your shoulders are square to the camera, which can look stiff. Angle one shoulder slightly toward the camera for a more natural, flattering look.');
  }

  // Type-specific tips
  if (pt === 'full-length') {
    if (Math.abs(m.horizontalOffset) < 0.15) {
      tips.push('In a full-body shot, try positioning yourself on the left or right third of the frame instead of dead center — it creates a more dynamic composition.');
    }
  } else if (pt === 'three-quarter') {
    if (m.bodyCropSafety === 'safe') {
      // Only show general tip if no specific crop issue was flagged
      tips.push('In a three-quarter shot, avoid cropping at the knees — mid-thigh or full-length works better.');
    }
    if (Math.abs(m.horizontalOffset) < 0.15) {
      tips.push('Try standing on the left or right third of the frame rather than dead center.');
    }
  } else if (pt === 'half-length') {
    if (Math.abs(m.horizontalOffset) < 0.15 && m.faceFramingRatio < 0.10) {
      tips.push('In a waist-up shot, placing yourself slightly off-center with space in the direction you\'re looking creates a more natural feel.');
    }
  }

  score = clamp(score);
  return {
    category: 'Composition & Framing',
    score,
    title: score >= 75 ? 'Composition is solid' : score >= 55 ? 'Framing needs adjustment' : 'Composition needs work',
    tip: tips.join(' ') || 'Good framing — your eyes are at the right height and the face fills the frame well.',
    priority: score < 55 ? 1 : score < 75 ? 2 : 3,
    gearNeeded: [],
  };
}

// ─── Sharpness ────────────────────────────────────────────────────────────────

function scoreSharpness(m) {
  const yawDeg = Math.abs(m.faceYawAngle * 180 / Math.PI);
  const frontalEyeSharpness = typeof m.leftEyeSharpness === 'number' && typeof m.rightEyeSharpness === 'number'
    ? (m.leftEyeSharpness + m.rightEyeSharpness) / 2
    : null;
  const eyeSharpness = yawDeg > 15 ? m.nearEyeSharpness : frontalEyeSharpness;
  const sharpnessSignal = typeof eyeSharpness === 'number'
    ? 0.50 * m.faceQualityScore + 0.50 * eyeSharpness
    : m.faceQualityScore;
  let score = Math.round(sharpnessSignal * 100);
  const tips = [];

  if (sharpnessSignal < 0.35) {
    tips.push('The photo is significantly blurry — probably camera shake or the focus missed. Hold the camera steadier, or tap the eye on screen to lock focus before shooting.');
  } else if (sharpnessSignal < 0.55) {
    tips.push('Slightly soft focus — the face isn\'t crisply sharp. Tap on the eye to set the focus point and make sure there\'s enough light so the camera can lock in.');
  }

  // Near-eye sharpness penalty for 3/4 views
  if (yawDeg > 15 && m.nearEyeSharpness < 0.5) {
    score -= 10;
    tips.push('When the face is turned to the side, the eye closest to the camera (the near eye) is what needs to be sharp. Tap directly on it to lock focus before the shot.');
  } else if (yawDeg <= 15 && Math.min(m.leftEyeSharpness, m.rightEyeSharpness) < 0.35) {
    score -= 12;
    tips.push('One eye is noticeably softer than the other. In a frontal portrait both eyes should land in focus, so tap between the eyes and give the camera a bit more light.');
  }

  const effectiveSignal = Math.min(sharpnessSignal, score / 100);
  if (effectiveSignal < 0.35 && !tips.some(t => t.includes('significantly blurry'))) {
    tips.push('The photo is significantly blurry — probably camera shake or the focus missed. Hold the camera steadier, or tap the eye on screen to lock focus before shooting.');
  } else if (effectiveSignal < 0.55 && !tips.some(t => t.includes('soft focus'))) {
    tips.push('Slightly soft focus — the face isn\'t crisply sharp. Tap on the eye to set the focus point and make sure there\'s enough light so the camera can lock in.');
  }

  score = clamp(score);
  return {
    category: 'Sharpness & Focus',
    score,
    title: score >= 75 ? 'Eyes are sharp and in focus' : score >= 50 ? 'Focus is soft' : 'Image is out of focus',
    tip: tips.join(' ') || 'The eyes and face are nice and sharp — good job.',
    priority: score < 50 ? 1 : score < 75 ? 2 : 3,
    gearNeeded: score < 50 ? ['tripod'] : [],
  };
}

// ─── Background ───────────────────────────────────────────────────────────────

function scoreBackground(m) {
  let score = 75;
  const tips = [];

  if (m.backgroundBrightness > 0.80) {
    score -= 20;
    tips.push('The background is very bright — it pulls the eye away from the face. Step away from the bright area, use a darker backdrop, or tap on the face in your camera to expose for it — the background will darken on its own.');
  } else if (m.backgroundBrightness < 0.10) {
    score += 5;
    tips.push('Dark background — clean separation.');
  }

  // Subject isolation (background blur)
  if (typeof m.subjectIsolationRatio === 'number') {
    if (m.subjectIsolationRatio > 3.0) {
      score += 5;
    } else if (m.subjectIsolationRatio < 1.5) {
      score -= 15;
      tips.push('The background is almost as sharp as the face, which makes the photo look busy. Try Portrait Mode on your phone, or move further from the background — even a few feet of distance helps create natural blur.');
    }
  }

  score = clamp(score);
  return {
    category: 'Background',
    score,
    title: score >= 75 ? 'Background works well' : score >= 55 ? 'Background needs attention' : 'Background is distracting',
    tip: tips.join(' ') || '',
    priority: score < 50 ? 2 : 3,
    gearNeeded: score < 50 ? ['backdrop'] : [],
  };
}

// ─── Eye contact & gaze ───────────────────────────────────────────────────────

function scoreEyeContact(m) {
  let score = 70;
  const tips = [];

  if (m.eyesObscured) {
    score = 75; // neutral — can't assess
    return {
      category: 'Eye Contact & Gaze',
      score,
      title: 'Eyes covered',
      tip: 'Can\'t assess eye contact through sunglasses. For the best coaching, try a photo without them.',
      priority: 3,
      gearNeeded: [],
    };
  }

  if (m.isWideEyed) {
    score -= 10;
    tips.push('Eyes look wide open, which can read as startled. Gently raise your lower eyelids — think "confident," not "surprised."');
  }

  // Only flag scleral show when NOT already squinching (otherwise the two
  // tips contradict each other — lifted lower lids are exactly the fix).
  if (m.inferiorScleralShow > 0.25 && !m.isSquinching) {
    score -= 8;
    tips.push('There\'s a bit of white showing below the iris, which can read as nervous. Relax the face and lift the lower eyelids slightly.');
  }

  if (m.isSquinching) {
    score += 15;
    tips.push('Nice — the slight lower-lid lift gives you a confident, grounded look. This is one of the biggest wins for a strong portrait.');
  }

  if (m.isDuchenneSmile) {
    score += 10;
    tips.push('Great genuine smile — your eyes are smiling too, which is what makes it feel real instead of posed.');
  } else if (m.isSmiling) {
    tips.push('The smile looks a little posed — the mouth is smiling but the eyes aren\'t quite there yet. Think of something that actually makes you laugh right before the shot.');
  }

  // Expression tension
  if (m.browTension > 0.3) {
    score -= 8;
    tips.push('Your forehead looks a bit tense — take a deep breath and let your eyebrows relax. Think calm confidence, not concentration.');
  }
  if (m.jawTension > 0.3) {
    score -= 5;
    tips.push('Your jaw looks tight. Open your mouth slightly, let it drop, then close gently — this relaxes the whole lower face.');
  }

  score = clamp(score);
  return {
    category: 'Eye Contact & Gaze',
    score,
    title: score >= 80 ? 'Strong, engaging eye contact' : score >= 65 ? 'Eye contact is decent' : 'Expression needs work',
    tip: tips.join(' ') || 'Eyes look naturally engaged.',
    priority: score < 60 ? 2 : 3,
    gearNeeded: [],
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateSummary(cards, overallScore) {
  const sorted = [...cards].sort((a, b) => a.score - b.score);
  const weakest = sorted[0];
  const strongest = sorted[sorted.length - 1];

  const strengths = cards.filter(c => c.score >= 75).map(c => c.category);
  const issues    = cards.filter(c => c.score < 55).map(c => c.category);
  const fix = s => s.toLowerCase();

  if (issues.length === 0 && overallScore >= 80) {
    const opener = pick([
      'Strong photo overall',
      'This one\'s looking good',
      'Nice work on this shot',
      'Solid photo',
    ]);
    const closer = weakest.score < 75
      ? pick([
          `To push it further, work on ${fix(weakest.category)}.`,
          `The one area to refine is ${fix(weakest.category)}.`,
          `A small tweak to ${fix(weakest.category)} would elevate it.`,
        ])
      : pick(['Keep it up.', 'Well done.', 'Nothing major to fix.']);
    return `${opener} — ${fix(strengths.slice(0, 2).join(' and '))} are working well. ${closer}`;
  }

  if (issues.length === 1) {
    const fixArea = fix(issues[0]);
    return pick([
      `Your ${fix(strongest.category)} is solid — focus on ${fixArea} to take this further.`,
      `${fix(strongest.category)} looks great. The main thing to work on is ${fixArea}.`,
      `Good foundation here. Improving ${fixArea} would make the biggest difference.`,
    ]);
  }

  if (issues.length >= 2) {
    const top2 = issues.slice(0, 2).map(fix).join(' and ');
    const strength = strengths.length ? fix(strengths[0]) : null;
    return pick([
      `${top2.charAt(0).toUpperCase() + top2.slice(1)} need the most work.${strength ? ` Your ${strength} is a strength — keep that.` : ''}`,
      `Focus on ${top2} first — those will have the biggest impact.${strength ? ` ${strength.charAt(0).toUpperCase() + strength.slice(1)} is already working well.` : ''}`,
      `Start with ${top2} — fixing those will improve the photo the most.`,
    ]);
  }

  return pick([
    `Decent shot — improving ${fix(weakest.category)} would help the most.`,
    `Not bad overall. ${fix(weakest.category).charAt(0).toUpperCase() + fix(weakest.category).slice(1)} is the area to focus on.`,
    `Good starting point — work on ${fix(weakest.category)} to level it up.`,
  ]);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }
