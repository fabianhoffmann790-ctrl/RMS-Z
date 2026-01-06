// src/logic/planCalculator.js
import {
  fillingLanes,
  productionLanes,
  ibcLane,
  getAllowedRWsForVolume,
  isRWFree,
  getLastEndForLane,
  makeEqualSplit,
  findBestRW,
  buildRwBatchEvent
} from "./timelineEngine";

// ========================================================
// DEFAULT CONFIG
// ========================================================
const DEFAULTS = {
  STEP_MIN: 5,

  LINE_RATE_LPM: 30,
  IBC_FILL_LPM: 80,
  PROD_TIME_MIN: 120,

  CLUSTER_GAP_MIN: 240,

  // 🔧 User-Requirement: kleinster Batch 1500L
  MIN_BATCH_L: 1500,
  MAX_BATCH_L: 13000,

  // Wie viele Batches ein Produkt-Cluster maximal haben darf (Sicherheits-Cap)
  MAX_BATCHES_PER_CLUSTER: 40,

  // Wie viele Split-Kandidaten wir behalten
  MIN_SPLIT_CANDIDATES: 5,
  MAX_SPLIT_CANDIDATES: 12,

  // Zielgrößen für Batch-Scoring/Kandidaten
  TARGET_BATCH_SIZES: [13000, 10000, 7500, 7000, 6500, 5000, 4700, 4000, 3500, 3000, 2500, 2000, 1500]
};

// ========================================================
// PUBLIC ENTRY
// ========================================================
export function calculatePlanV02({ lineJobs, manualAssignments, locks, config }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const plannedEvents = [];
  const diagnostics = [];

  // 3.1 Demand Timeline (Linien)
  const demand = buildDemandTimeline(lineJobs, cfg);

  // 3.2 IST Assignments => locked rwBatch from 0..fillEnd
  const { coveredDemandIds } = applyManualAssignments({
    demand,
    manualAssignments,
    plannedEvents,
    cfg,
    diagnostics
  });

  const openDemand = demand.filter(d => !coveredDemandIds.has(d.id));

  // 3.3 Product clustering
  const clusters = clusterByProduct(openDemand, cfg.CLUSTER_GAP_MIN);

  // 3.4–3.6 Split candidates + construct + schedule
  for (const cluster of clusters) {
    const candidates = generateSplitCandidates(cluster.totalVolumeL, cfg);
    let scheduled = false;

    for (const variant of candidates) {
      const attempt = tryScheduleCluster({
        cluster,
        splitVariant: variant,
        plannedEvents,
        cfg,
        diagnostics
      });

      if (attempt.ok) {
        plannedEvents.push(...attempt.eventsToAdd);
        scheduled = true;
        break;
      }
    }

    if (!scheduled) {
      // Fallback: IBC (Cluster-Ansätze splitten!)
      scheduleClusterViaIBC(cluster, plannedEvents, diagnostics, cfg);
    }
  }

  // Locks (produziert/erledigt) – aktuell no-op (Events werden über manualAssignments gelockt)
  if (locks && Array.isArray(locks) && locks.length) {
    // reserved
  }

  // 5.1 Validator (minimal): keine RW-overlaps
  const overlaps = validateNoRwOverlaps(plannedEvents, cfg);
  const ok = overlaps.length === 0;

  return {
    ok,
    // ✅ UI erwartet result.events
    events: plannedEvents,
    // legacy/Debug
    plannedEvents,
    diagnostics,
    overlaps
  };
}

// ========================================================
// 3.1 Demand Timeline (Linien)
// Accept: Array<Job> ODER Map<lineId, Job[]>
// ========================================================
function buildDemandTimeline(lineJobs, cfg) {
  const LINE_RATE = cfg.LINE_RATE_LPM;
  const jobsByLine = coerceLineJobsToMap(lineJobs);

  const demand = [];

  for (const lineId of Object.keys(jobsByLine).sort()) {
    const orders = (jobsByLine[lineId] || [])
      .map((o, idx) => normalizeJob(o, idx, lineId))
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

    let cursor = 0;

    for (const o of orders) {
      const volumeL = Number(o.volumeL ?? 0);
      if (!Number.isFinite(volumeL) || volumeL <= 0) continue;

      const durationMin = volumeL / LINE_RATE;

      const start = o.isIstPos1 ? 0 : cursor;
      const end = start + durationMin;

      const id = `demand_${lineId}_${String(o.orderId ?? o.orderIndex ?? "x")}`;

      demand.push({
        id,
        type: "lineFill",
        laneType: "LINE",
        laneId: lineId,
        lane: lineId, // legacy for UI
        orderId: o.orderId ?? `${lineId}_${o.orderIndex}`,
        orderIndex: o.orderIndex ?? 0,
        productId: o.productId ?? "UNKNOWN",
        volumeL,
        start,
        end,
        covered: false
      });

      cursor = end;
    }
  }

  return demand;
}

function coerceLineJobsToMap(lineJobs) {
  // Case A: already a map { Linie1:[...], Linie2:[...] }
  if (lineJobs && !Array.isArray(lineJobs) && typeof lineJobs === "object") {
    // If it looks like {lineId: Job[]}
    const keys = Object.keys(lineJobs);
    if (keys.length === 0) return {};
    const firstVal = lineJobs[keys[0]];
    if (Array.isArray(firstVal)) return lineJobs;
  }

  // Case B: Array of jobs
  if (Array.isArray(lineJobs)) {
    const map = {};
    for (let i = 0; i < lineJobs.length; i++) {
      const j = lineJobs[i] || {};
      const lineId = j.lineId || j.line || j.lineLane || "Linie1";
      if (!map[lineId]) map[lineId] = [];
      map[lineId].push(j);
    }
    return map;
  }

  return {};
}

function normalizeJob(raw, fallbackIndex, fallbackLineId) {
  const lineId = raw.lineId || raw.line || fallbackLineId;

  return {
    orderId: raw.orderId ?? raw.id ?? `${lineId}_${fallbackIndex}`,
    lineId,
    orderIndex: raw.orderIndex ?? raw.order ?? raw.pos ?? fallbackIndex,
    productId: raw.productId ?? raw.product ?? raw.lineProduct ?? "UNKNOWN",
    volumeL: Number(raw.volumeL ?? raw.volume ?? raw.lineVolume ?? 0),
    isIstPos1: Boolean(raw.isIstPos1 ?? raw.isPos1 ?? false)
  };
}

// ========================================================
// 3.2 IST Assignments
// ========================================================
function applyManualAssignments({ demand, manualAssignments, plannedEvents, cfg, diagnostics }) {
  const coveredDemandIds = new Set();

  if (!manualAssignments || typeof manualAssignments !== "object") {
    return { coveredDemandIds };
  }

  for (const rwId of Object.keys(manualAssignments)) {
    const ma = manualAssignments[rwId];
    if (!ma || ma.locked !== true) continue;

    // find matching demand
    const d = demand.find(x => String(x.orderId) === String(ma.orderId));
    if (!d) {
      diagnostics.push({
        level: "WARN",
        code: "IST_ASSIGNMENT_NO_DEMAND",
        rwId,
        orderId: ma.orderId
      });
      continue;
    }

    // locked rwBatch from 0..fillEnd (no production)
    const ev = buildRwBatchEvent({
      rwId,
      productId: d.productId,
      volumeL: d.volumeL,
      slotStart: 0,
      slotEnd: d.end,
      locked: true,
      consumers: [
        {
          demandId: d.id,
          lineId: d.laneId,
          orderId: d.orderId,
          start: d.start,
          end: d.end,
          volumeL: d.volumeL
        }
      ]
    });

    plannedEvents.push(ev);
    coveredDemandIds.add(d.id);
    d.covered = true;
  }

  return { coveredDemandIds };
}

// ========================================================
// 3.3 Product clustering
// ========================================================
function clusterByProduct(openDemand, gapMin) {
  const byProd = new Map();

  for (const d of openDemand) {
    const key = d.productId;
    if (!byProd.has(key)) byProd.set(key, []);
    byProd.get(key).push(d);
  }

  const clusters = [];

  for (const [productId, list] of [...byProd.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const demand = [...list].sort((a, b) => a.start - b.start);

    let current = null;

    for (const d of demand) {
      if (!current) {
        current = { productId, demand: [d] };
        continue;
      }

      const prev = current.demand[current.demand.length - 1];
      const gap = d.start - prev.start;

      if (gap <= gapMin) {
        current.demand.push(d);
      } else {
        clusters.push(enrichCluster(current));
        current = { productId, demand: [d] };
      }
    }

    if (current) clusters.push(enrichCluster(current));
  }

  return clusters;
}

function enrichCluster(c) {
  const total = c.demand.reduce((sum, d) => sum + d.volumeL, 0);
  const start = Math.min(...c.demand.map(d => d.start));
  const end = Math.max(...c.demand.map(d => d.end));

  return {
    ...c,
    id: `cluster_${c.productId}_${start.toFixed(2)}`,
    totalVolumeL: total,
    start,
    end
  };
}

// ========================================================
// 3.4 Split candidates
// ========================================================
function generateSplitCandidates(totalL, cfg) {
  const MIN = cfg.MIN_BATCH_L ?? 1500;
  const MAX = cfg.MAX_BATCH_L ?? 13000;

  const minN = Math.max(1, Math.ceil(totalL / MAX));     // wegen max RW
  const maxN = Math.max(minN, Math.ceil(totalL / MIN));  // wegen min Batch
  const nCap = Math.min(maxN, cfg.MAX_BATCHES_PER_CLUSTER ?? 40);

  const wanted = new Set();

  // N aus Ziel-Ø-Batchgrößen ableiten
  const targets = cfg.TARGET_BATCH_SIZES || [13000, 10000, 7500, 7000, 6500, 5000, 4700, 4000, 3500, 3000, 2500, 2000, 1500];
  for (const t of targets) {
    const n1 = Math.round(totalL / t);
    const n2 = Math.ceil(totalL / t);
    const n3 = Math.floor(totalL / t);

    for (const n of [n1, n2, n3]) {
      if (Number.isFinite(n) && n >= minN && n <= nCap) wanted.add(n);
    }
  }

  // einige n am unteren Ende (wenige Batches) + einige am oberen Ende (kleinere Batches)
  for (let n = minN; n <= Math.min(nCap, minN + 10); n++) wanted.add(n);
  if (nCap > minN + 10) {
    for (let n = Math.max(minN, nCap - 6); n <= nCap; n++) wanted.add(n);
  }

  const variants = [];

  for (const n of [...wanted].sort((a, b) => a - b)) {
    const batches = makeEqualSplit(totalL, n);

    // harte Grenzen
    if (batches.some(v => v < MIN || v > MAX)) continue;

    // muss in mindestens ein RW passen
    if (batches.some(v => getAllowedRWsForVolume(v).length === 0)) continue;

    variants.push(batches);
  }

  // Fallback: split by MAX (z.B. bei extremen Werten)
  if (variants.length === 0) {
    const fb = splitByMax(totalL, MAX, MIN);
    if (fb && fb.every(v => v >= MIN && v <= MAX) && fb.every(v => getAllowedRWsForVolume(v).length > 0)) {
      variants.push(fb);
    }
  }

  // scoren + top-K übernehmen
  const scored = variants
    .map(batches => ({ batches, score: scoreSplitCandidate(batches) }))
    .sort((a, b) => a.score - b.score);

  const minC = cfg.MIN_SPLIT_CANDIDATES ?? 5;
  const maxC = cfg.MAX_SPLIT_CANDIDATES ?? 12;

  const picked = scored.slice(0, Math.min(maxC, Math.max(minC, scored.length))).map(x => x.batches);

  return picked.length > 0 ? picked : [makeEqualSplit(totalL, minN)];
}

function scoreSplitCandidate(batches) {
  // kleiner Score ist besser
  const mean = batches.reduce((a, b) => a + b, 0) / batches.length;
  const variance = batches.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / batches.length;
  const std = Math.sqrt(variance);

  // viele Batches leicht bestrafen
  return std + batches.length * 0.5;
}

function splitByMax(total, max, min) {
  const n = Math.ceil(total / max);
  const batches = makeEqualSplit(total, n);
  if (batches.some(v => v < min || v > max)) return null;
  return batches;
}

// ========================================================
// 3.5/3.6 Batch-Konstruktion + Scheduling (Cluster -> Batches -> RW)
// ========================================================
function tryScheduleCluster({ cluster, splitVariant, plannedEvents, cfg, diagnostics }) {
  // FIFO allocation: demand segments in chronological order
  const demand = [...cluster.demand].sort((a, b) => a.start - b.start);
  let demandIdx = 0;

  const eventsToAdd = [];

  // build batches from splitVariant
  for (let b = 0; b < splitVariant.length; b++) {
    const batchVol = splitVariant[b];

    // allocate consumers: take from demand in order until batchVol covered
    let remaining = batchVol;
    const consumers = [];

    while (remaining > 0.0001 && demandIdx < demand.length) {
      const d = demand[demandIdx];
      const take = Math.min(remaining, d.volumeL);

      consumers.push({
        demandId: d.id,
        lineId: d.laneId,
        orderId: d.orderId,
        start: d.start,
        end: d.end,
        volumeL: take,
        productId: d.productId
      });

      // reduce demand volume
      d.volumeL -= take;
      remaining -= take;

      if (d.volumeL <= 0.0001) demandIdx++;
    }

    if (remaining > 0.0001) {
      // not enough demand to fill this batch (should not happen)
      diagnostics.push({ level: "WARN", code: "BATCH_OVER_ALLOC", clusterId: cluster.id });
    }

    if (consumers.length === 0) continue;

    const firstFillStart = Math.min(...consumers.map(c => c.start));
    const lastFillEnd = Math.max(...consumers.map(c => c.end));

    // Slot is blocked from productionStart..lastFillEnd
    const slotStart = firstFillStart - cfg.PROD_TIME_MIN;
    const slotEnd = lastFillEnd;

    // choose RW via scoring
    const candidates = getAllowedRWsForVolume(batchVol);

    const best = findBestRW({
      volumeL: batchVol,
      productId: cluster.productId,
      slotStart,
      slotEnd,
      events: plannedEvents.concat(eventsToAdd),
      candidates
    });

    if (!best) {
      return { ok: false, eventsToAdd: [] };
    }

    const rwId = best.rwId;

    const rwBatch = buildRwBatchEvent({
      rwId,
      productId: cluster.productId,
      volumeL: batchVol,
      slotStart,
      slotEnd,
      locked: false,
      consumers
    });

    eventsToAdd.push(rwBatch);

    // add lineFill events (presentation-level, but we keep them as events)
    for (const c of consumers) {
      eventsToAdd.push({
        id: `lineFill_${c.lineId}_${c.orderId}_${b}_${c.demandId}`,
        type: "lineFill",
        laneType: "LINE",
        laneId: c.lineId,
        lane: c.lineId,
        productId: c.productId,
        orderId: c.orderId,
        volumeL: c.volumeL,
        start: c.start,
        end: c.end,
        from: "RW",
        rwId
      });
    }
  }

  return { ok: true, eventsToAdd };
}

// ========================================================
// 3.8 IBC-Engine (Fallback)
// ========================================================
function scheduleClusterViaIBC(cluster, plannedEvents, diagnostics, cfg) {
  // create IBC batches (split by 1000L but stay within min/max)
  const totalL = cluster.totalVolumeL;

  const MAX = cfg.MAX_BATCH_L ?? 13000;
  const MIN = cfg.MIN_BATCH_L ?? 1500;

  const batches = splitByMax(totalL, MAX, MIN) || makeEqualSplit(totalL, Math.ceil(totalL / MAX));
  const ibcBatches = batches.map(v => ({
    volumeL: v,
    ibcCount: Math.ceil(v / 1000)
  }));

  // schedule on "IBC lane" (unlimited), using earliest start of cluster (can be much earlier)
  let cursor = Math.max(0, cluster.start - cfg.PROD_TIME_MIN * 2);

  for (let i = 0; i < ibcBatches.length; i++) {
    const b = ibcBatches[i];

    // IBC fill duration
    const ibcFillMin = b.volumeL / cfg.IBC_FILL_LPM;

    const start = cursor;
    const end = start + cfg.PROD_TIME_MIN + ibcFillMin; // production + IBC fill

    plannedEvents.push({
      id: `ibcBatch_${cluster.id}_${i}`,
      type: "ibcBatch",
      laneType: "IBC",
      laneId: ibcLane,
      lane: ibcLane,
      productId: cluster.productId,
      volumeL: b.volumeL,
      ibcCount: b.ibcCount,
      start,
      end,
      reason: "CLUSTER_UNSCHEDULED_DIRECT"
    });

    cursor = end + cfg.STEP_MIN;
  }

  diagnostics.push({
    level: "WARN",
    code: "CLUSTER_FALLBACK_IBC",
    clusterId: cluster.id,
    productId: cluster.productId,
    totalVolumeL: totalL
  });
}

// ========================================================
// 5.1 Validator: No RW overlaps (rwBatch only)
// ========================================================
function validateNoRwOverlaps(events, cfg) {
  const overlaps = [];

  const byRw = new Map();

  for (const e of events) {
    if (e.type !== "rwBatch") continue;
    if (!e.rwId && !e.lane) continue;

    const rwId = e.rwId || e.lane;
    if (!byRw.has(rwId)) byRw.set(rwId, []);
    byRw.get(rwId).push(e);
  }

  for (const [rwId, list] of byRw.entries()) {
    const sorted = [...list].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];

      if (cur.start < prev.end) {
        overlaps.push({
          rwId,
          a: { id: prev.id, start: prev.start, end: prev.end },
          b: { id: cur.id, start: cur.start, end: cur.end }
        });
      }
    }
  }

  return overlaps;
}
