import React from "react";
import { minutesToPixels } from "../logic/timelineEngine";

// 0 Minuten im Plan = 06:00 Uhr
const BASE_MINUTES = 6 * 60;

function floorDiv(a, b) {
  return Math.floor(a / b);
}

function formatFromSix(minutesFromPlanStart) {
  const total = BASE_MINUTES + minutesFromPlanStart;

  const day = floorDiv(total, 1440);
  const mod = ((total % 1440) + 1440) % 1440;

  const hh = String(Math.floor(mod / 60)).padStart(2, "0");
  const mm = String(mod % 60).padStart(2, "0");

  if (day === 0) return `${hh}:${mm}`;
  const sign = day > 0 ? "+" : "-";
  return `${sign}${Math.abs(day)}d ${hh}:${mm}`;
}

export default function TimeAxis({ start, end, scale }) {
  const width = minutesToPixels(end - start, scale);

  // Major alle 60min, Minor alle 30min
  const majorStep = 60;
  const minorStep = 30;

  const ticks = [];
  const t0 = Math.floor(start / minorStep) * minorStep;

  for (let t = t0; t <= end; t += minorStep) {
    const isMajor = t % majorStep === 0;
    ticks.push({ t, isMajor });
  }

  return (
    <div className="relative h-8 border-b border-slate-700" style={{ width }}>
      {ticks.map(({ t, isMajor }) => {
        const x = minutesToPixels(t - start, scale);
        return (
          <div key={t} className="absolute top-0 h-full" style={{ left: x }}>
            <div className={`h-full ${isMajor ? "border-l border-slate-500" : "border-l border-slate-700"}`} />
            {isMajor && (
              <div className="absolute -top-0.5 left-1 text-[10px] text-slate-300 whitespace-nowrap">
                {formatFromSix(t)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
