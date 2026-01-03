// src/logic/timelineEngine.js

// --------------------------------------------------------
// RÜHRWERKDEFINITIONEN (echte Namen + min/max Liter)
// --------------------------------------------------------
export const reactors = [
  // Große RW
  { id: "A1", name: "A1", min: 5000, max: 13000, type: "big" },
  { id: "A2", name: "A2", min: 5000, max: 13000, type: "big" },
  { id: "RW09", name: "RW09", min: 5000, max: 13000, type: "big" },
  { id: "RW10", name: "RW10", min: 5000, max: 13000, type: "big" },
  { id: "RW11", name: "RW11", min: 5000, max: 13000, type: "big" },

  // Kleine / mittlere RW
  { id: "RW05", name: "RW05", min: 2000, max: 7500, type: "small" },
  { id: "RW04", name: "RW04", min: 1500, max: 7000, type: "small" },
  { id: "RW02", name: "RW02", min: 700, max: 5000, type: "small" },
  { id: "RW01", name: "RW01", min: 700, max: 4900, type: "small" },
  { id: "RW03-Y", name: "RW03-Y", min: 500, max: 4700, type: "small" },

  // Sonderfall – nicht automatisch nutzen!
  { id: "Ex-Diss", name: "Ex-Diss", min: 150, max: 1000, type: "special" }
];

export const productionLanes = reactors.filter(r => r.type !== "special").map(r => r.id);
export const fillingLanes = ["Linie1", "Linie2", "Linie3", "Linie4", "Linie5"];
export const ibcLane = "IBC";

// --------------------------------------------------------
// UI/RENDER HELPERS
// --------------------------------------------------------
export function minutesToPixels(min, scale) {
  return min * scale;
}

export function computeTimelineBounds(events) {
  if (!events || events.length === 0) return { min: 0, max: 600 };

  const minStart = Math.min(0, ...events.map(e => (e?.start ?? 0)));
  const maxEnd = Math.max(0, ...events.map(e => (e?.end ?? 0)));

  return {
    min: minStart,
    max: maxEnd + 200
  };
}




export function generateDummyEvents() {
  return [];
}

// --------------------------------------------------------
// ERLAUBTE RÜHRWERKE FÜR VOLUMEN (min/max strikt, klein->groß)
// --------------------------------------------------------
export function getAllowedRWsForVolume(volumeL) {
  return reactors
    .filter(rw => rw.type !== "special" && volumeL >= rw.min && volumeL <= rw.max)
    .sort((a, b) => a.max - b.max)
    .map(rw => rw.id);
}

// --------------------------------------------------------
// OVERLAP CHECK (isRWFree) – gilt für rwBatch + cleaning + ibcRWSlot
// --------------------------------------------------------
export function isRWFree(events, rwId, start, end) {
  if (!Array.isArray(events)) return false;
  const list = events.filter(e => e.lane === rwId);
  for (const ev of list) {
    const s = ev.start ?? 0;
    const t = ev.end ?? 0;
    const overlap = !(end <= s || start >= t);
    if (overlap) return false;
  }
  return true;
}

export function getLastEndForLane(events, lane) {
  if (!Array.isArray(events)) return 0;
  const list = events.filter(e => e.lane === lane);
  if (list.length === 0) return 0;
  return Math.max(...list.map(e => e.end ?? 0));
}

// --------------------------------------------------------
// BATCHING v0.2: Split-Variante erzeugen (gleichmäßig, keine Mini-Reste)
// -> wird vom Planner genutzt, um 5–12 Kandidaten zu bauen
// --------------------------------------------------------
export function makeEqualSplit(total, n) {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  const arr = Array(n).fill(base);
  for (let i = 0; i < rest; i++) arr[i] += 1;
  return arr;
}

// --------------------------------------------------------
// Volume-Fit Penalty (kleine Batches nicht in big, große nicht in small)
// --------------------------------------------------------
export function getVolumeFitPenalty(volumeL, rwId) {
  const r = reactors.find(x => x.id === rwId);
  if (!r) return 999;

  if (volumeL < 7000 && r.type === "big") return 10;
  if (volumeL > 7500 && r.type === "small") return 10;

  const waste = r.max - volumeL;
  return Math.max(0, waste / 1000);
}

// --------------------------------------------------------
// RW SLOT (EIN EVENT pro Batch) – DIRECT
// belegt: prodStart -> lastFillEnd
// phases: production + fillingSegments[] + cleaning optional
// --------------------------------------------------------
export function buildRwBatchEvent({
  rwId,
  productId,
  volumeL,
  prodStart,
  prodEnd,
  lastFillEnd,
  fillingSegments,
  locked = false,
  mode = "DIRECT" // DIRECT | IBC
}) {
  return {
    id: "rwBatch_" + crypto.randomUUID(),
    type: "rwBatch",
    lane: rwId,
    rwId,
    productId,
    volumeL,
    start: prodStart,
    end: lastFillEnd,
    locked,
    mode,
    label: `${locked ? "IST" : "GEPLANT"} · ${productId} · ${Math.round(volumeL)}L`,
    color: locked ? "#f97316" : "#94a3b8",
    phases: {
      production: { start: prodStart, end: prodEnd },
      fillingSegments: fillingSegments || [],
      cleaning: null,
      ibcFilling: null
    }
  };
}

// --------------------------------------------------------
// Scoring-basiert bestes RW finden (kann später erweitert werden)
// --------------------------------------------------------
export function findBestRW({ volumeL, productId, slotStart, slotEnd, events, candidates }) {
  let best = null;

  for (const rwId of candidates) {
    if (!isRWFree(events, rwId, slotStart, slotEnd)) continue;

    const lastEnd = getLastEndForLane(events, rwId);
    const idleGap = Math.max(0, slotStart - lastEnd);
    const fitPenalty = getVolumeFitPenalty(volumeL, rwId);

    // fragmentationPenalty (simple): wenn Lücke, dann schlecht
    const fragmentationPenalty = idleGap > 0 ? 1 : 0;

    const score = idleGap * 2 + fitPenalty * 5 + fragmentationPenalty * 3;

    if (!best || score < best.score) {
      best = { rwId, score };
    }
  }

  return best;
}
