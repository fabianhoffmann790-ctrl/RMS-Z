// --------------------------------------------------------
// RÜHRWERKDEFINITIONEN (echte Namen + min/max Liter)
// --------------------------------------------------------
export const reactors = [
  // Große RW
  { name: "A1", min: 5000, max: 13000, type: "big" },
  { name: "A2", min: 5000, max: 13000, type: "big" },
  { name: "RW09", min: 5000, max: 13000, type: "big" },
  { name: "RW10", min: 5000, max: 13000, type: "big" },
  { name: "RW11", min: 5000, max: 13000, type: "big" },

  // Kleine / mittlere RW
  { name: "RW05", min: 2000, max: 7500, type: "small" },
  { name: "RW04", min: 1500, max: 7000, type: "small" },
  { name: "RW02", min: 700,  max: 5000, type: "small" },
  { name: "RW01", min: 700,  max: 4900, type: "small" },
  { name: "RW03-Y", min: 500, max: 4700, type: "small" },

  // Sonderfall – nicht automatisch nutzen!
  { name: "Ex-Diss", min: 150, max: 1000, type: "special" }
];

export const productionLanes = reactors
  .filter(r => r.type !== "special")
  .map(r => r.name);

export const fillingLanes = ["Linie1", "Linie2", "Linie3", "Linie4", "Linie5"];

// --------------------------------------------------------
// KOLLISIONSERKENNUNG – IST DAS RW ZU DIESEM ZEITRAUM FREI?
// --------------------------------------------------------
export function isRWFree(events, rwName, start, end) {
  if (!Array.isArray(events)) return false;

  const list = events.filter(e => e.lane === rwName);

  for (const ev of list) {
    const overlap = !(end <= ev.start || start >= ev.end);
    if (overlap) return false;
  }
  return true;
}


// --------------------------------------------------------
// ERLAUBTE RÜHRWERKE FÜR EIN BATCH-VOLUMEN
// Liefert sortierte Liste (bevorzugt klein → groß)
// --------------------------------------------------------
export function getAllowedRWsForVolume(volume) {
  return reactors
    .filter(rw => {
      if (rw.type === "special") return false; // Ex-Diss später separat
      return volume >= rw.min && volume <= rw.max;
    })
    .sort((a, b) => {
      // möglichst kleiner RW zuerst
      return a.max - b.max;
    })
    .map(rw => rw.name);
}


// --------------------------------------------------------
// HILFSFUNKTIONEN
// --------------------------------------------------------
export function minutesToPixels(min, scale) {
  return min * scale;
}

export function computeTimelineBounds(events) {
  if (!events || events.length === 0) return { min: 0, max: 600 };

  const min = Math.min(...events.map(e => e.start ?? 0));
  const max = Math.max(...events.map(e => e.end ?? 0));

  return {
    min: min - 30,     // etwas Luft links
    max: max + 200     // etwas Luft rechts
  };
}



// --------------------------------------------------------
// PRODUKT-RUN SPLITTING (NEU)
// - erst Runs bilden, dann splitten
// - kein "max 4" mehr (große Mengen erzeugen viele Batches)
// - vermeidet Mini-Rest < MIN_REST
// - nutzt bei 7.5k..13k wenn möglich 2x <= 7.5k (kleine RW nutzbar)
// --------------------------------------------------------
export function splitRunVolumeIntoBatches(total) {
  const MIN_REST = 3500;
  const SMALL_MAX = 7500;
  const BIG_MAX = 13000;

  const res = [];
  let remaining = Math.round(Number(total));

  if (!Number.isFinite(remaining) || remaining <= 0) return [];

  while (remaining > 0) {
    // passt locker in small
    if (remaining <= SMALL_MAX) {
      res.push(remaining);
      break;
    }

    // passt in big, aber nicht in small
    if (remaining <= BIG_MAX) {
      // wenn möglich in 2 splitten, damit small RW genutzt werden kann
      const a = Math.ceil(remaining / 2);
      const b = remaining - a;

      if (
        a <= SMALL_MAX &&
        b <= SMALL_MAX &&
        a >= MIN_REST &&
        b >= MIN_REST
      ) {
        res.push(a, b);
      } else {
        res.push(remaining);
      }
      break;
    }

    // remaining > BIG_MAX
    const remainderAfterBig = remaining - BIG_MAX;

    // würde ein Mini-Rest entstehen? -> rebalance die letzten 2 Batches
    if (remainderAfterBig > 0 && remainderAfterBig < MIN_REST) {
      const combined = BIG_MAX + remainderAfterBig; // < 16500

      let a = Math.ceil(combined / 2);
      let b = combined - a;

      // sicherstellen >= MIN_REST
      if (a < MIN_REST) {
        a = MIN_REST;
        b = combined - a;
      }
      if (b < MIN_REST) {
        b = MIN_REST;
        a = combined - b;
      }

      res.push(a, b);
      break;
    }

    // normal: 13k abziehen
    res.push(BIG_MAX);
    remaining -= BIG_MAX;
  }

  return res;
}

// --------------------------------------------------------
// BESTES RW FINDEN (Scoring)
// --------------------------------------------------------
export function findBestRW({
  volume,
  product,
  fillStart,
  fillEnd,
  productionTime,
  events,
  candidates // Array von RW-Namen
}) {
  let best = null;

  for (const rw of candidates) {
    // Slot so planen, dass er exakt zum Fill-Fixpunkt passt
    const res = scheduleRWSlot({
      volume,
      product,
      rw,
      fillStart,
      fillEnd,
      productionTime,
      events
    });

    if (res.conflict) continue;

    const slot = res.rwSlotEvent;

    // ---- Scoring ----
    // 1) Je kürzer der Slot, desto besser (hier konstant, aber bleibt für Zukunft)
    const slotDuration = slot.end - slot.start;

    // 2) "Ende-der-letzten-Belegung" als Glättung (weniger Lücken)
    const lastEnd = getLastEndForLane(events, rw);
    const idleGap = Math.max(0, slot.start - lastEnd); // Leerlauf vor dem Slot

    // 3) Größen-Fit: kleine Batches sollen nicht unnötig große RW belegen
    const fitPenalty = getVolumeFitPenalty(volume, rw);

    // Gewichtung (einfach, robust):
    const score = idleGap * 2 + fitPenalty * 5 + slotDuration * 0.1;

    if (!best || score < best.score) {
      best = { rw, score, slot };
    }
  }

  return best; // null wenn nichts passt
}

// --------------------------------------------------------
// Strafpunkte für "schlechter Fit" (klein in groß vermeiden)
// --------------------------------------------------------
export function getVolumeFitPenalty(volume, rwName) {
  const r = reactors.find(x => x.name === rwName);
  if (!r) return 100;

  // harte Regeln aus deinem Werk:
  // wenn < 7000L → kleine RW bevorzugen
  if (volume < 7000 && r.type === "big") return 10;

  // wenn sehr groß → big bevorzugen
  if (volume > 7500 && r.type === "small") return 10;

  // sonst: je mehr Reserve, desto mehr "Verschwendung"
  const waste = r.max - volume; // Liter "Luft"
  return Math.max(0, waste / 1000); // grob in 1kL Schritten
}



// --------------------------------------------------------
// RW-SLOT PLANEN (EIN EINZIGER SLOT pro Batch)
// Produktion endet exakt am Abfüllstart.
// RW bleibt bis Ende Abfüllung belegt.
// --------------------------------------------------------
export function scheduleRWSlot({
  volume,
  product,
  rw,
  fillStart,
  fillEnd,
  productionTime,
  events
}) {
  const prodEnd = fillStart;
  const prodStart = prodEnd - productionTime;

  const slotStart = prodStart;
  const slotEnd = fillEnd;

  // Negative Zeiten sind erlaubt (Produktion vor 06:00 etc.)
  if (!isRWFree(events, rw, slotStart, slotEnd)) {
    return { conflict: true };
  }

  return {
    conflict: false,
    rwSlotEvent: {
  id: "rwslot_" + crypto.randomUUID(),
  lane: rw,
  type: "rw-slot",
  product,
  label: `RW belegt: ${product}`,      // ✅ sichtbar + Produktname
  color: "#64748b",                    // ✅ sichtbarer Block (grau)
  start: slotStart,
  end: slotEnd,
  phases: {
    production: { start: prodStart, end: prodEnd },
    filling: { start: fillStart, end: fillEnd }
  }
}

  };
}







// --------------------------------------------------------
// ABFÜLLUNG EINPLANEN (FIXPUNKT!)
// Dauer = Liter / 30 L/min
// --------------------------------------------------------
export function scheduleFilling(batchVolume, fillingLane, product, earliestStart, events) {
  const FILL_RATE = 30; // L/min
  const duration = batchVolume / FILL_RATE;

  // Start = Ende der letzten Abfüllung auf dieser Linie
  const last = events
    .filter(e => e.lane === fillingLane)
    .map(e => e.end);

  const lastEnd = last.length > 0 ? Math.max(...last) : 0;

  const start = Math.max(lastEnd, earliestStart);
  const end = start + duration;

  return {
    id: "fill_" + crypto.randomUUID(),
    lane: fillingLane,
    label: `Abfüllung ${product}`,
    start,
    end,
    color: "#eab308"
  };
}
// --------------------------------------------------------
// LETZTES ENDE EINER LANE
// --------------------------------------------------------
export function getLastEndForLane(events, lane) {
  const list = events.filter(ev => ev.lane === lane);
  if (list.length === 0) return 0;
  return Math.max(...list.map(ev => ev.end));
}


// --------------------------------------------------------
// DUMMY-EVENTS (leer, kann später genutzt werden)
// --------------------------------------------------------
export function generateDummyEvents() {
  return [];
}

