export const pilot = {
  keys: new Set<string>(),
  injected: new Set<string>(),
  mouseX: 0,
  mouseY: 0,
  stickX: 0,
  stickY: 0,
  liftUp: false,
  liftDown: false,
  /** Armed by the Start button even if the world is still mounting. */
  arm: false,
  running: false,
  /** When set, replaces A/D. +1 is nose-left (same sign as KeyA). */
  steerOverride: null as number | null,
  reducedMotion: false,
};

export function held(code: string) {
  return pilot.keys.has(code) || pilot.injected.has(code);
}

export type FlightFlags = {
  wire: boolean;
  night: boolean;
  onGround: boolean;
  locked: boolean;
};

export type FlightMeters = {
  alt: number;
  agl: number;
  speed: number;
  heading: number;
  cardinal: string;
  onGround: boolean;
};

declare global {
  interface Window {
    __controlsTest?: {
      getYaw: () => number;
      getSpeed: () => number;
      setKeys: (codes: string[]) => void;
      setSteer?: (v: number) => void;
    };
    __kammflug?: {
      start: () => void;
      toggleWire: () => void;
      setNight: (night: boolean) => void;
    };
    __flightReady?: boolean;
  }
}
