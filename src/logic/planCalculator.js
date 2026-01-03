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

// ----------------------------
// DEFAULT CONFIG
// ----------------------------
const DEFAULTS = {
  // rates in L/min
  FILL_RATE: 30,
  IBC_RATE: 80,

  // fixed production time per batch (min)
  PROD_TIME: 120,

  // product clustering
  CLUSTER_GAP_MIN: 240,

  // batching constraints (user rule)
  MIN_BATCH_L: 1500,
  MAX_BATCH_L: 13000,

  // candidate generation limits
  MAX_BATCHES_PER_CLUSTER: 40,
  MIN_SPLIT_CANDIDATES: 5,
  MAX_SPLIT_CANDIDATES: 12,

  // "target" average batch sizes to explore (helps small RWs get used)
  TARGET_BATCH_SIZES: [13000, 10000, 7500, 7000, 6500, 5000, 4700, 4000, 3500, 3000, 2500, 2000, 1500]
};

// ----------------------------
// PUBLIC ENTRY
// ----------------------------
export function calculatePlanV02({ lineJobs, manualAssignments, locks, config }) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const plannedEvents = [];
  const diagnostics = [];

  // 3.1 Demand Timeline
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

  // (optional) Locks berücksichtigen (produziert/erledigt) – falls du das später aktiv nutzt:
  if (locks && Array.isArray(locks) && locks.length) {
    // currently no-op: events are already locked via manualAssignments or UI
  }

  // 5.1 Validator (minimal): keine RW-overlaps
  const overlaps = validateNoOverlaps(plannedEvents);
  overlaps.forEach(o => diagnostics.push({ type: "RW_OVERLAP", ...o }));

  return {
    plannedEvents,
    demandEvents: demand,
    diagnostics
  };
}

// ========================================================
// 3.1 Demand Timeline
// ========================================================
function buildDemandTimeline(lineJobs, cfg) {
  const events = [];
  for (const lineId of Object.keys(lineJobs || {})) {
    const jobs = lineJobs[lineId] || [];
    let t = 0;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const volumeL = Number(job.volumeL || job.volume || 0);
      const durationMin = volumeL / cfg.FILL_RATE;

      const start = job.isIstPos1 ? 0 : t;
      const end = start + durationMin;

      const id = "lineFill_" + crypto.randomUUID();

      events.push({
        id,
        type: "lineFill",
        lane: lineId,
        lineId,
        orderId: job.orderId,
        productId: job.productId,
        volumeL,
        start,
        end,
        orderIndex: job.orderIndex,
        isIstPos1: !!job.isIstPos1,
        label: `Abfüllung ${job.productId} · ${Math.round(volumeL)}L`
      });

      t = end;
    }
  }
  return events;
}

// ========================================================
// 3.2 Manual IST assignments
// ========================================================
function applyManualAssignments({ demand, manualAssignments, plannedEvents, cfg, diagnostics }) {
  const coveredDemandIds = new Set();
  if (!manualAssignments) return { coveredDemandIds };

  for (const [rwId, assign] of Object.entries(manualAssignments)) {
    if (!assign) continue;

    // nur Pos1 zulassen
    const d = demand.find(x => x.orderId === assign.orderId && x.isIstPos1);
    if (!d) {
      diagnostics.push({
        type: "IST_ASSIGN_INVALID",
        rwId,
        reason: "Kein passender Pos1-Demand gefunden",
        assign
      });
      continue;
    }

    const fillEnd = d.end;

    plannedEvents.push(buildRwBatchEvent({
      rwId,
      productId: assign.productId,
      volumeL: assign.volumeL ?? d.volumeL,
      prodStart: 0,
      prodEnd: 0,         // IST: Produktion nicht separat visualisiert (kannst du später ergänzen)
      lastFillEnd: fillEnd,
      fillingSegments: [{
        demandId: d.id,
        lineId: d.lineId,
        orderId: d.orderId,
        start: d.start,
        end: d.end,
        volumeL: d.volumeL
      }],
      locked: true,
      mode: "IST"
    }));

    coveredDemandIds.add(d.id);
  }

  return { coveredDemandIds };
}

// ========================================================
// 3.3 Product clustering
// ========================================================
function clusterByProduct(demandEvents, gapMin) {
  const byProd = new Map();
  for (const d of demandEvents) {
    if (!byProd.has(d.productId)) byProd.set(d.productId, []);
    byProd.get(d.productId).push(d);
  }

  const clusters = [];
  for (const [productId, arr] of byProd.entries()) {
    const sorted = [...arr].sort((a, b) => a.start - b.start);
    let cur = null;

    for (const ev of sorted) {
      if (!cur) {
        cur = {
          id: "cluster_" + crypto.randomUUID(),
          productId,
          demand: [ev],
          startMin: ev.start,
          endMax: ev.end,
          totalVolumeL: ev.volumeL
        };
        continue;
      }

      if (ev.start - cur.endMax <= gapMin) {
        cur.demand.push(ev);
        cur.endMax = Math.max(cur.endMax, ev.end);
        cur.totalVolumeL += ev.volumeL;
      } else {
        clusters.push(cur);
        cur = {
          id: "cluster_" + crypto.randomUUID(),
          productId,
          demand: [ev],
          startMin: ev.start,
          endMax: ev.end,
          totalVolumeL: ev.volumeL
        };
      }
    }
    if (cur) clusters.push(cur);
  }

  // Sortierung nach frühestem Bedarf
  clusters.sort((a, b) => a.startMin - b.startMin);
  return clusters;
}

function splitByMax(totalL, maxL, minL) {
  const batches = [];
  let remaining = totalL;

  while (remaining > maxL) {
    batches.push(maxL);
    remaining -= maxL;
  }
  batches.push(remaining);

  // ensure last batch >= minL (redistribute from previous batches if needed)
  if (batches.length > 1 && batches[batches.length - 1] < minL) {
    let need = minL - batches[batches.length - 1];

    for (let i = 0; i < batches.length - 1 && need > 0; i++) {
      const canGive = Math.max(0, batches[i] - minL);
      const give = Math.min(need, canGive);
      if (give > 0) {
        batches[i] -= give;
        batches[batches.length - 1] += give;
        need -= give;
      }
    }

    if (batches[batches.length - 1] < minL) return null;
  }

  return batches;
}

function scoreSplitCandidate(batches) {
  const n = batches.length;

  // balance
  const mean = batches.reduce((a, b) => a + b, 0) / n;
  const variance = batches.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  const std = Math.sqrt(variance);

  // flexibility: how many RWs can run each batch?
  const eligibleCounts = batches.map(v => getAllowedRWsForVolume(v).length);
  const flex = eligibleCounts.reduce((a, c) => a + Math.log(1 + c), 0);

  // scarcity penalty: batches that only fit in 1-2 RWs are risky
  const scarcityPenalty = eligibleCounts.reduce((a, c) => {
    if (c <= 1) return a + 8;
    if (c === 2) return a + 3;
    return a;
  }, 0);

  // too many "large" batches -> mostly only big RWs (A1/A2/RW09-11)
  const largeBatchPenalty = batches.reduce((a, v) => a + (v > 7500 ? 1 : 0), 0) * 0.6;

  // fragmentation: more batches = more complexity
  const countPenalty = n * 0.8;

  // imbalance: avoid one tiny remainder
  const balancePenalty = std / 1200;

  // lower is better
  return countPenalty + largeBatchPenalty + balancePenalty + scarcityPenalty - flex * 3;
}

// ========================================================
// 3.4 Split-Engine mit Kandidaten (E2)
// generiert mehrere Split-Varianten, damit große Cluster auch kleine RWs nutzen können
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
        lineId: d.lineId,
        orderId: d.orderId,
        start: d.start,
        end: d.end,
        volumeL: take
      });

      remaining -= take;

      // we don't partial-split demand timeline visually; but allocation is logical.
      // move on to next demand event once this one is fully covered in allocation
      demandIdx++;
    }

    // if not enough demand left -> invalid split
    if (remaining > 0.0001) {
      return { ok: false, reason: "SPLIT_TOO_LARGE" };
    }

    const firstFillStart = Math.min(...consumers.map(c => c.start));
    const lastFillEnd = Math.max(...consumers.map(c => c.end));

    // schedule RW slot backward-friendly: start production so that prodEnd <= firstFillStart
    const desiredProdEnd = firstFillStart;
    const desiredProdStart = Math.max(0, desiredProdEnd - cfg.PROD_TIME);

    const rwId = findBestRW({
      volumeL: batchVol,
      productId: cluster.productId,
      slotStart: desiredProdStart,
      slotEnd: lastFillEnd,
      events: [...plannedEvents, ...eventsToAdd],
      candidates: getAllowedRWsForVolume(batchVol)
    });

    if (!rwId) {
      return { ok: false, reason: "NO_RW" };
    }

    // ensure free
    if (!isRWFree([...plannedEvents, ...eventsToAdd], rwId, desiredProdStart, lastFillEnd)) {
      return { ok: false, reason: "RW_NOT_FREE" };
    }

    // create rwBatch
    eventsToAdd.push(buildRwBatchEvent({
      rwId,
      productId: cluster.productId,
      volumeL: batchVol,
      prodStart: desiredProdStart,
      prodEnd: desiredProdStart + cfg.PROD_TIME,
      lastFillEnd,
      fillingSegments: consumers,
      locked: false,
      mode: "GEPLANT"
    }));
  }

  return { ok: true, eventsToAdd };
}

// ========================================================
// IBC fallback (Cluster-Level)
// ========================================================
function scheduleClusterViaIBC(cluster, plannedEvents, diagnostics, cfg) {
  // Wichtig: Cluster können viel größer als ein RW sein.
  // Für IBC-Fallback splitten wir daher den Cluster in mehrere IBC-Ansätze (je <= MAX_BATCH_L)
  // und planen diese als "IBC-Produktionen" auf RWs ein (Produktion + IBC-Füllzeit blockiert das RW).

  const MIN = cfg.MIN_BATCH_L ?? 1500;
  const MAX = cfg.MAX_BATCH_L ?? 13000;

  const runs = splitByMax(cluster.totalVolumeL, MAX, MIN) || [Math.min(cluster.totalVolumeL, MAX)];

  for (const volumeL of runs) {
    const rwCandidates = getAllowedRWsForVolume(volumeL);

    if (rwCandidates.length === 0) {
      plannedEvents.push({
        id: "ibcBatch_" + crypto.randomUUID(),
        type: "ibcBatch",
        lane: ibcLane,
        productId: cluster.productId,
        volumeL,
        ibcCount: Math.ceil(volumeL / 1000),
        start: cluster.startMin,
        end: cluster.startMin,
        label: `IBC x${Math.ceil(volumeL / 1000)} (UNSCHEDULED)`,
        color: "#ef4444",
        reason: ["CLUSTER_FALLBACK_NO_RW_FOR_VOLUME"]
      });

      diagnostics.push({
        type: "UNSCHEDULED_BATCH",
        reason: "IBC fallback: kein RW für Batch-Volumen",
        productId: cluster.productId,
        volumeL
      });
      continue;
    }

    // wähle RW mit frühester Verfügbarkeit (und freiem Slot über gesamten Zeitraum)
    let best = null;

    for (const rwId of rwCandidates) {
      const baseStart = getLastEndForLane(plannedEvents, rwId);
      const prodStart = baseStart;
      const prodEnd = prodStart + cfg.PROD_TIME;
      const ibcDuration = volumeL / cfg.IBC_RATE;
      const lastFillEnd = prodEnd + ibcDuration;

      if (!isRWFree(plannedEvents, rwId, prodStart, lastFillEnd)) continue;

      if (!best || prodStart < best.prodStart) {
        best = { rwId, prodStart, prodEnd, lastFillEnd };
      }
    }

    if (!best) {
      plannedEvents.push({
        id: "ibcBatch_" + crypto.randomUUID(),
        type: "ibcBatch",
        lane: ibcLane,
        productId: cluster.productId,
        volumeL,
        ibcCount: Math.ceil(volumeL / 1000),
        start: cluster.startMin,
        end: cluster.startMin,
        label: `IBC x${Math.ceil(volumeL / 1000)} (UNSCHEDULED)`,
        color: "#ef4444",
        reason: ["CLUSTER_FALLBACK_NO_FREE_RW"]
      });

      diagnostics.push({
        type: "UNSCHEDULED_BATCH",
        reason: "IBC fallback: kein freier RW-Slot",
        productId: cluster.productId,
        volumeL
      });
      continue;
    }

    // RW ist belegt (Produktion + IBC-Füllung)
    plannedEvents.push(buildRwBatchEvent({
      rwId: best.rwId,
      productId: cluster.productId,
      volumeL,
      prodStart: best.prodStart,
      prodEnd: best.prodEnd,
      lastFillEnd: best.lastFillEnd,
      fillingSegments: [],
      locked: false,
      mode: "IBC"
    }));

    // separater IBC-Event auf IBC-Lane (nur visuell / nachvollziehbar)
    plannedEvents.push({
      id: "ibcBatch_" + crypto.randomUUID(),
      type: "ibcBatch",
      lane: ibcLane,
      productId: cluster.productId,
      volumeL,
      ibcCount: Math.ceil(volumeL / 1000),
      start: best.prodEnd,
      end: best.lastFillEnd,
      label: `IBC x${Math.ceil(volumeL / 1000)} ${cluster.productId} · ${Math.round(volumeL)}L`,
      color: "#38bdf8",
      reason: ["CLUSTER_FALLBACK"]
    });
  }
}

// ========================================================
// 5.1 Validator: no overlaps on same lane (RWs + Lines + IBC)
// ========================================================
function validateNoOverlaps(events) {
  const byLane = new Map();
  for (const e of events) {
    if (!e.lane) continue;
    if (!byLane.has(e.lane)) byLane.set(e.lane, []);
    byLane.get(e.lane).push(e);
  }

  const overlaps = [];
  for (const [lane, arr] of byLane.entries()) {
    const sorted = [...arr].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start < prev.end - 1e-6) {
        overlaps.push({
          lane,
          a: { id: prev.id, start: prev.start, end: prev.end, type: prev.type },
          b: { id: cur.id, start: cur.start, end: cur.end, type: cur.type }
        });
      }
    }
  }
  return overlaps;
}
