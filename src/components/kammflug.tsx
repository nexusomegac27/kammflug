import { useEffect, useRef, useState, type ReactNode } from "react";
import { Compass, Download, Grid3x3, Moon, Sun } from "lucide-react";
import { pilot, type FlightFlags, type FlightMeters } from "@/game/input";
import { type DemStatus } from "@/game/dem";
import { type WeatherStatus } from "@/game/weather";
import { previewPathPrefix } from "@/lib/preview-path-prefix";

export function Kammflug() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const altRef = useRef<HTMLSpanElement>(null);
  const aglRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);
  const kmhRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const [started, setStarted] = useState(false);
  const [flags, setFlags] = useState<FlightFlags>({
    wire: false,
    night: false,
    onGround: false,
    locked: false,
  });
  const [failed, setFailed] = useState(false);
  const [dem, setDem] = useState<DemStatus>({ phase: "loading", done: 0, total: 0 });
  const [weather, setWeather] = useState<WeatherStatus>({ phase: "loading" });
  const [showLookHint, setShowLookHint] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hideHint = () => setShowLookHint(false);
    canvas.addEventListener("pointerdown", hideHint);
    return () => canvas.removeEventListener("pointerdown", hideHint);
  }, [started]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dispose = () => {};
    let dead = false;

    const onMeters = (m: FlightMeters) => {
      if (altRef.current) altRef.current.textContent = `${Math.round(m.alt)} m`;
      if (aglRef.current) aglRef.current.textContent = `${Math.round(m.agl)} m über Grund`;
      if (speedRef.current) speedRef.current.textContent = `${Math.round(m.speed)}`;
      if (kmhRef.current) kmhRef.current.textContent = `${Math.round(m.speed * 3.6)} km/h`;
      if (headRef.current) headRef.current.textContent = `${Math.round(m.heading).toString().padStart(3, "0")}`;
      if (cardRef.current) cardRef.current.textContent = m.cardinal;
      if (barRef.current) {
        const pct = Math.max(0, Math.min(1, m.speed / 130));
        barRef.current.style.transform = `scaleX(${pct})`;
      }
    };

    void import("@/game/world")
      .then(({ mount }) => {
        if (dead || !canvasRef.current) return;
        dispose = mount(canvasRef.current, onMeters, setFlags, setDem, setWeather);
      })
      .catch(() => {
        if (!dead) setFailed(true);
      });

    return () => {
      dead = true;
      dispose();
    };
  }, []);

  function start() {
    pilot.arm = true;
    window.__kammflug?.start();
    setStarted(true);
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-ink text-paper">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />

      {!started && (
        <div className="pointer-events-none absolute inset-0 flex items-end md:items-stretch">
          <aside className="sheet fade-in pointer-events-auto flex w-full flex-col gap-4 overflow-auto bg-paper p-5 text-ink md:p-8">
            <p className="font-sans text-xs font-semibold tracking-widest text-moss uppercase">
              Low-Poly · Madeira
            </p>
            <h1 className="font-display text-5xl leading-none text-ink">Kammflug</h1>
            <p className="max-w-sm text-base leading-snug text-ink-soft">
              Die Insel kommt aus gemessenen Höhen, das Wetter live von Open-Meteo. Beides nur im Kreis von
              32 km um Madeira — Punkte und Kacheln außerhalb lehnt die Schnittstelle ab.
            </p>
            <p className="text-sm text-ink-soft">
              {dem.phase === "loading" &&
                (dem.total > 0 ? `Höhenkacheln ${dem.done} / ${dem.total}` : "Radius wird vermessen")}
              {dem.phase === "ready" &&
                `${dem.tiles} Kacheln · ${dem.source} · höchster Punkt ${dem.maxElev} m`}
              {dem.phase === "error" && dem.message}
            </p>
            <p className="text-sm text-ink">
              {weather.phase === "loading" && "Wetter im Inselradius wird gelesen"}
              {weather.phase === "error" && weather.message}
              {weather.phase === "ready" &&
                `${weather.tempC.toFixed(1).replace(".", ",")} °C · ${weather.label} · Wind ${weather.windMs.toFixed(1).replace(".", ",")} m/s aus ${weather.windFrom}, Böen ${weather.gustMs.toFixed(0)}${weather.observedAt ? ` · Stand ${weather.observedAt}` : ""}`}
            </p>
            <ul className="grid gap-1 text-sm text-ink-soft">
              <li>Maus — Blick, W / S — Schub</li>
              <li>A / D — Ruder links / rechts</li>
              <li>Q / E oder Pfeile hoch / runter — Nase</li>
              <li>Leertaste / Strg — steigen / sinken</li>
              <li>F — Drahtmodell, N — Tag / Nacht</li>
            </ul>
            {failed || dem.phase === "error" ? (
              <p className="text-sm font-medium text-amber-deep">
                {failed ? "Diese Ansicht braucht WebGL." : "Die Höhen konnten nicht geladen werden."}
              </p>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={start}
                  disabled={dem.phase !== "ready"}
                  className="inline-flex h-12 items-center justify-center rounded-hud bg-amber px-5 font-display text-2xl text-ink disabled:opacity-50"
                >
                  {dem.phase === "ready" ? "Starten" : "Messen"}
                </button>
                <a
                  href="/kammflug-paket.zip"
                  download="kammflug-paket.zip"
                  onClick={(event) => {
                    const prefix =
                      previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
                    event.currentTarget.href = `${prefix}/kammflug-paket.zip`;
                  }}
                  className="inline-flex h-12 items-center gap-2 rounded-hud bg-ink px-4 font-sans text-sm font-semibold text-paper"
                >
                  <Download aria-hidden="true" className="h-4 w-4" />
                  Paket laden
                </a>
              </div>
            )}
          </aside>
        </div>
      )}

      <div className={started ? "pointer-events-none absolute inset-0" : "hidden"}>
        <div className="pointer-events-auto absolute top-3 right-3 left-3 flex flex-wrap justify-end gap-2 md:left-auto">
          <a
            href="/kammflug-paket.zip"
            download="kammflug-paket.zip"
            onClick={(event) => {
              const prefix = previewPathPrefix(window.location.hostname, window.location.pathname) ?? "";
              event.currentTarget.href = `${prefix}/kammflug-paket.zip`;
            }}
            className="inline-flex h-12 items-center gap-2 rounded-hud bg-paper px-3 font-sans text-sm font-semibold text-ink"
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            Paket
          </a>
          <Toggle
            pressed={flags.wire}
            label={flags.wire ? "Draht an" : "Draht aus"}
            onClick={() => window.__kammflug?.toggleWire()}
          >
            <Grid3x3 aria-hidden="true" />
            Draht
          </Toggle>
          <Toggle
            pressed={!flags.night}
            label="Tag"
            onClick={() => window.__kammflug?.setNight(false)}
          >
            <Sun aria-hidden="true" />
            Tag
          </Toggle>
          <Toggle
            pressed={flags.night}
            label="Nacht"
            onClick={() => window.__kammflug?.setNight(true)}
          >
            <Moon aria-hidden="true" />
            Nacht
          </Toggle>
        </div>

        {started && !flags.locked && showLookHint && (
          <p className="pointer-events-none absolute top-16 right-3 rounded-full bg-ink px-3 py-2 text-sm text-paper md:top-20">
            Ziehen oder klicken für den Mausblick
          </p>
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-3">
          <section className="w-full max-w-xs rounded-hud bg-paper p-4 text-ink">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-widest text-moss uppercase">Höhe</p>
                <p className="font-display num text-4xl leading-none">
                  <span ref={altRef}>0 m</span>
                </p>
                <p className="num mt-1 text-sm text-ink-soft">
                  <span ref={aglRef}>0 m über Grund</span>
                </p>
              </div>
              <div className="text-right">
                <p className="inline-flex items-center gap-1 text-xs font-semibold tracking-widest text-moss uppercase">
                  <Compass aria-hidden="true" className="h-3.5 w-3.5" />
                  Kurs
                </p>
                <p className="font-display num text-4xl leading-none">
                  <span ref={headRef}>000</span>
                </p>
                <p className="text-sm text-ink-soft">
                  <span ref={cardRef}>N</span>
                </p>
              </div>
            </div>
            <div className="mt-3">
              <div className="flex items-baseline justify-between">
                <p className="text-xs font-semibold tracking-widest text-moss uppercase">Schub</p>
                <p className="num text-sm text-ink-soft">
                  <span ref={speedRef}>0</span> m/s · <span ref={kmhRef}>0 km/h</span>
                </p>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper-deep">
                <span
                  ref={barRef}
                  className="block h-full w-full origin-left rounded-full bg-amber"
                  style={{ transform: "scaleX(0)" }}
                />
              </div>
            </div>
            {flags.onGround && (
              <p className="mt-3 inline-flex rounded-full bg-moss px-3 py-1 text-xs font-semibold tracking-wide text-paper uppercase">
                Bodenkontakt
              </p>
            )}
            <div className="mt-3 border-t border-paper-deep pt-3">
              <p className="text-xs font-semibold tracking-widest text-moss uppercase">Wetter</p>
              {weather.phase === "ready" ? (
                <>
                  <p className="font-display text-2xl leading-none">
                    {weather.tempC.toFixed(1).replace(".", ",")} °C · {weather.label}
                  </p>
                  <p className="num mt-1 text-sm text-ink-soft">
                    Wind {weather.windMs.toFixed(1).replace(".", ",")} m/s aus {weather.windFrom}, Böen {weather.gustMs.toFixed(0)}
                    {" · "}
                    Sicht {weather.visibilityKm.toFixed(0)} km
                  </p>
                </>
              ) : (
                <p className="text-sm text-ink-soft">
                  {weather.phase === "error" ? weather.message : "Wird gemessen"}
                </p>
              )}
            </div>
            <p className="mt-3 text-xs leading-snug text-mist">
              {dem.phase === "ready"
                ? `${dem.source} · Open-Meteo · nur ${dem.radiusKm} km Radius`
                : "Messdaten nur im beobachteten Radius"}
            </p>
          </section>

          <div className="touch-only pointer-events-auto flex-col items-end gap-3">
            <div className="flex gap-2">
              <HoldButton label="Steigen" onHold={(down) => (pilot.liftUp = down)}>
                Hoch
              </HoldButton>
              <HoldButton label="Sinken" onHold={(down) => (pilot.liftDown = down)}>
                Runter
              </HoldButton>
            </div>
            <Stick />
          </div>
        </div>
      </div>
    </main>
  );
}

function Toggle({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={
        pressed
          ? "inline-flex h-12 items-center gap-2 rounded-hud bg-amber px-3 font-sans text-sm font-semibold text-ink"
          : "inline-flex h-12 items-center gap-2 rounded-hud bg-paper px-3 font-sans text-sm font-semibold text-ink"
      }
    >
      {children}
    </button>
  );
}

function HoldButton({
  label,
  onHold,
  children,
}: {
  label: string;
  onHold: (down: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex h-14 min-w-14 items-center justify-center rounded-hud bg-paper px-3 font-sans text-sm font-semibold text-ink"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onHold(true);
      }}
      onPointerUp={() => onHold(false)}
      onPointerCancel={() => onHold(false)}
    >
      {children}
    </button>
  );
}

function Stick() {
  const padRef = useRef<HTMLDivElement>(null);
  const nubRef = useRef<HTMLDivElement>(null);

  function move(clientX: number, clientY: number) {
    const pad = padRef.current;
    const nub = nubRef.current;
    if (!pad || !nub) return;
    const rect = pad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const max = rect.width / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, max);
    dx = (dx / len) * clamped;
    dy = (dy / len) * clamped;
    pilot.stickX = dx / max;
    pilot.stickY = -dy / max;
    nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function reset() {
    pilot.stickX = 0;
    pilot.stickY = 0;
    if (nubRef.current) {
      nubRef.current.style.transform = "translate(-50%, -50%)";
    }
  }

  return (
    <div
      ref={padRef}
      role="slider"
      aria-label="Schub und Ruder"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={0}
      className="relative h-28 w-28 touch-none rounded-full border border-mist bg-paper"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.stopPropagation();
        move(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX, e.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
    >
      <div
        ref={nubRef}
        className="absolute top-1/2 left-1/2 h-12 w-12 rounded-full bg-amber"
        style={{ transform: "translate(-50%, -50%)" }}
      />
    </div>
  );
}
