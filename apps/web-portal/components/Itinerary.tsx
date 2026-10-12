import { Slice } from '@/lib/api';
import { dayOf, duration, timeOf } from '@/lib/format';

/** One row per slice: departure, carrier and duration, arrival. */
export function Itinerary({ slices }: { slices: Slice[] }) {
  return (
    <div className="legs">
      {slices.map((s, i) => {
        const first = s.segments[0];
        const last = s.segments[s.segments.length - 1];
        const stops = s.segments.length - 1;
        return (
          <div className="leg" key={i}>
            <div>
              <div className="t">{timeOf(first.departureLocal)}</div>
              <div className="muted small">
                {first.origin} · {dayOf(first.departureLocal)}
              </div>
            </div>
            <div className="mid">
              {s.segments.map((g) => g.flightNumber).join(' + ')} · {duration(s.durationMin)} ·{' '}
              {stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="t">{timeOf(last.arrivalLocal)}</div>
              <div className="muted small">{last.destination}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
