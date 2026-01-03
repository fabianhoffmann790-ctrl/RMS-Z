import {
  scheduleFilling,
  getAllowedRWsForVolume,
  getLastEndForLane,
  isRWFree,
  findBestRW,
  splitRunVolumeIntoBatches
} from "./timelineEngine";

/**
 * RMS-Z Plan: produkt-run-basiert
 * - pro Linie gleiche Produkte zusammenfassen (Runs)
 * - Runs in Batches splitten
 * - jede Batch bekommt filling + (RW-slot oder IBC-Fallback)
 */
export function calculatePlanFromJobs(lineJobs) {
  const plannedEvents = [];
  const PRODUCTION_TIME = 120;
  const IBC_RATE = 80; // L/min

  // --- 1) Jobs pro Linie sammeln + sortieren
  const jobsByLine = {};
  for (const j of lineJobs) {
    if (!jobsByLine[j.line]) jobsByLine[j.line] = [];
    jobsByLine[j.line].push(j);
  }

  for (const line of Object.keys(jobsByLine)) {
    jobsByLine[line].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // --- 2) Pro Linie Produkt-Runs bilden (adjacent gleiche Produkte zusammenfassen)
  const runsByLine = {};
  for (const [line, jobs] of Object.entries(jobsByLine)) {
    const runs = [];
    for (const job of jobs) {
      const vol = Number(job.volume);
      if (!Number.isFinite(vol) || vol <= 0) continue;

      const last = runs[runs.length - 1];
      if (last && last.product === job.product) {
        last.volume += vol; // merge
      } else {
        runs.push({
          line,
          product: job.product,
          volume: vol
        });
      }
    }
    runsByLine[line] = runs;
  }

  // --- 3) Runs -> Batch-Demands (pro Linie in Reihenfolge)
  const batchDemandsByLine = {};
  for (const [line, runs] of Object.entries(runsByLine)) {
    const demands = [];
    let runIndex = 0;

    for (const run of runs) {
      runIndex += 1;

      const batches = splitRunVolumeIntoBatches(run.volume);
      batches.forEach((v, i) => {
        demands.push({
          id: `d_${line}_${runIndex}_${i + 1}`,
          line,
          product: run.product,
          volume: v,
          runIndex,
          batchIndex: i + 1
        });
      });
    }
    batchDemandsByLine[line] = demands;
  }

  // --- 4) Planung: pro Linie sequential füllen, pro Batch RW-slot oder IBC
  const lineCursors = {};
  for (const line of Object.keys(batchDemandsByLine)) {
    lineCursors[line] = 0;
  }

  for (const [line, demands] of Object.entries(batchDemandsByLine)) {
    let cursor = lineCursors[line];

    for (const d of demands) {
      // 4.1 Filling (Fixpunkt Linie)
      const filling = scheduleFilling(
        d.volume,
        d.line,
        d.product,
        cursor,
        plannedEvents
      );
      cursor = filling.end;

      // 4.2 RW-slot versuchen (DIRECT)
      const candidates = getAllowedRWsForVolume(d.volume);

      const best = findBestRW({
        volume: d.volume,
        product: d.product,
        fillStart: filling.start,
        fillEnd: filling.end,
        productionTime: PRODUCTION_TIME,
        events: plannedEvents,
        candidates
      });

      if (best && best.slot) {
        // RW-slot Event rein, sauber labeln (UI zeigt Produkt direkt im Block)
        plannedEvents.push({
          ...best.slot,
          label: `RW belegt ${d.product}`,
          color: "#94a3b8" // grau
        });

        plannedEvents.push({
          ...filling,
          label: `Abfüllung ${d.product}`,
          color: "#eab308",
          source: best.rw
        });
      } else {
        // 4.3 IBC Fallback: Produktion + IBC-Abfüllung am RW (nächster freier Slot)
        scheduleBatchViaIBC({
          product: d.product,
          volume: d.volume,
          plannedEvents,
          productionTime: PRODUCTION_TIME,
          ibcRate: IBC_RATE
        });

        plannedEvents.push({
          ...filling,
          label: `Abfüllung ${d.product} (aus IBC)`,
          color: "#eab308",
          source: "IBC"
        });
      }
    }

    lineCursors[line] = cursor;
  }

  return plannedEvents;
}

// --------------------------------------------------------
// IBC: nächster freier Slot (einfach & robust)
// RW ist nur während Produktion + IBC-Abfüllung belegt
// --------------------------------------------------------
function scheduleBatchViaIBC({ product, volume, plannedEvents, productionTime, ibcRate }) {
  const ibcDuration = volume / ibcRate;
  const rwList = getAllowedRWsForVolume(volume);

  for (const rw of rwList) {
    const start = getLastEndForLane(plannedEvents, rw);
    const prodEnd = start + productionTime;
    const ibcEnd = prodEnd + ibcDuration;

    if (isRWFree(plannedEvents, rw, start, ibcEnd)) {
      plannedEvents.push({
        id: "prod_ibc_" + crypto.randomUUID(),
        lane: rw,
        label: `Produktion ${product} (IBC)`,
        start,
        end: prodEnd,
        color: "#0ea5e9",
        ibc: true
      });

      plannedEvents.push({
        id: "ibc_fill_" + crypto.randomUUID(),
        lane: rw,
        label: `IBC-Abfüllung ${product}`,
        start: prodEnd,
        end: ibcEnd,
        color: "#38bdf8",
        ibc: true
      });

      return;
    }
  }

  // kein RW frei → Konfliktmarker (damit nichts "verschwindet")
  plannedEvents.push({
    id: "ibc_conflict_" + crypto.randomUUID(),
    lane: rwList[0] ?? "A1",
    label: `IBC KONFLIKT ${product}`,
    start: 0,
    end: productionTime,
    color: "#dc2626",
    conflict: true
  });
}
