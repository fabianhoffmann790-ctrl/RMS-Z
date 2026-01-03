import React from "react";
import { minutesToPixels } from "../logic/timelineEngine";

export default function LaneRow({ lane, events, scale, startOffset }) {
  const rowHeight = 40;

  return (
    <div
      className="border-b border-gray-700 flex items-center relative"
      style={{ height: rowHeight }}
    >
      <div
        className="w-32 text-right pr-2 text-sm opacity-70 absolute left-0"
        style={{ top: "50%", transform: "translateY(-50%)" }}
      >
        {lane}
      </div>

      <div className="ml-32 h-full relative">
        {events.map(e => {
          const left = minutesToPixels(e.start - startOffset, scale);
          const width = minutesToPixels(e.end - e.start, scale);

          const conflictClass = e.conflict ? "ring-2 ring-red-400" : "";

return (
  <div
    key={e.id}
    className={
      "absolute top-1 bottom-1 rounded text-xs flex flex-col items-center justify-center " +
      conflictClass
    }
    style={{
      left,
      width,
      backgroundColor: e.color
    }}
  >
    <span>{e.label}</span>
    {e.sourceRW && (
      <span className="text-[10px] opacity-70">
        (von {e.sourceRW})
      </span>
    )}
    {e.conflict && (
      <span className="text-[9px] opacity-80 mt-0.5">
        Konflikt
      </span>
    )}
  </div>
);

        })}
      </div>
    </div>
  );
}
