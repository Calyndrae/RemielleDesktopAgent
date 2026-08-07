/**
 * When she is allowed to do something on her own.
 *
 * A desktop companion that only ever reacts is a chat window with a picture
 * next to it. One that acts whenever it likes is spyware with a nice face. This
 * module is the whole of the difference: every rule about *when* she may move,
 * change pose, or say something unprompted lives here, as pure functions over a
 * clock, so the parts that are easy to get wrong are testable without waiting
 * an hour to find out.
 *
 * The rules, in the order they are checked:
 *
 * 1. Turned off entirely — nothing, ever.
 * 2. The chat panel is open — she holds still. Handled by `ambientSuspended` in
 *    the agent store rather than here, because it is about interaction, not
 *    about the clock.
 * 3. Quiet hours — a window you can sleep or work through.
 * 4. "Not today" — one click silences her until tomorrow.
 * 5. A daily cap, so a long day cannot accumulate into pestering.
 */

/** Minutes since local midnight, which is how quiet hours are stored. */
export type MinuteOfDay = number;

export interface AmbientSettings {
  enabled: boolean;
  /** Bounds of the random gap between activities, in minutes. */
  minMinutes: number;
  maxMinutes: number;
  /** Inclusive start, exclusive end. Equal values mean "no quiet hours". */
  quietFrom: MinuteOfDay;
  quietTo: MinuteOfDay;
  /** Most activities in one local day. */
  dailyCap: number;
}

export const DEFAULT_AMBIENT: AmbientSettings = {
  enabled: true,
  // Long enough that she is a presence rather than an event. Anything under
  // about half an hour stops reading as "she happens to be there".
  minMinutes: 45,
  maxMinutes: 120,
  quietFrom: 22 * 60,
  quietTo: 8 * 60,
  dailyCap: 6,
};

export interface AmbientState {
  /** Local calendar day the counter belongs to. */
  day: string;
  firedToday: number;
  /** The day "今天别再打扰我" was clicked, if it was. */
  mutedDay: string | null;
}

export const EMPTY_AMBIENT_STATE: AmbientState = {
  day: "",
  firedToday: 0,
  mutedDay: null,
};

/**
 * The local calendar day, as `YYYY-MM-DD`.
 *
 * Deliberately local rather than UTC: "today" means the user's today, and a
 * counter that rolled over at 08:00 local because the machine is in UTC+8 would
 * be visibly wrong to the only person who can see it.
 */
export function localDay(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether `now` falls inside the quiet window.
 *
 * The window usually wraps midnight — 22:00 to 08:00 is the default and the
 * obvious thing to want — so a naive `from <= t && t < to` is wrong for exactly
 * the case people configure first. When the bounds are inverted the window is
 * the *union* of the two ends of the day instead of the span between them.
 */
export function inQuietHours(now: Date, settings: AmbientSettings): boolean {
  const { quietFrom, quietTo } = settings;
  if (quietFrom === quietTo) return false;

  const minute = now.getHours() * 60 + now.getMinutes();
  return quietFrom < quietTo
    ? minute >= quietFrom && minute < quietTo
    : minute >= quietFrom || minute < quietTo;
}

/** Rolls the counter over when the calendar day has changed. */
export function rollDay(state: AmbientState, now: Date): AmbientState {
  const today = localDay(now);
  if (state.day === today) return state;
  // The mute is deliberately *not* cleared here: it is compared against today's
  // date, so it expires by becoming stale rather than by being reset.
  return { ...state, day: today, firedToday: 0 };
}

export type AmbientBlock = "off" | "quiet" | "muted" | "capped" | null;

/**
 * Why she may not act right now, or `null` if she may.
 *
 * Returns the reason rather than a boolean so settings can say which rule is
 * currently holding her back — "she has been quiet because you capped her at
 * six" is actionable in a way that a disabled toggle is not.
 */
export function ambientBlock(
  state: AmbientState,
  settings: AmbientSettings,
  now: Date,
): AmbientBlock {
  if (!settings.enabled) return "off";
  if (inQuietHours(now, settings)) return "quiet";
  if (state.mutedDay === localDay(now)) return "muted";

  const rolled = rollDay(state, now);
  if (rolled.firedToday >= settings.dailyCap) return "capped";
  return null;
}

export function canFire(
  state: AmbientState,
  settings: AmbientSettings,
  now: Date,
): boolean {
  return ambientBlock(state, settings, now) === null;
}

/**
 * How long until the next attempt, in milliseconds.
 *
 * Uniform inside the configured range. Bounds arriving reversed or nonsensical
 * are repaired rather than trusted — they come from a settings file a user can
 * edit, and a zero or negative delay would busy-loop the scheduler.
 */
export function nextDelayMs(settings: AmbientSettings, random = Math.random): number {
  const low = Math.max(1, Math.min(settings.minMinutes, settings.maxMinutes));
  const high = Math.max(low, Math.max(settings.minMinutes, settings.maxMinutes));
  const minutes = low + random() * (high - low);
  return Math.round(minutes * 60_000);
}

/** The kinds of thing she can do unprompted. */
export type Activity = "emote" | "greeting";

/**
 * Picks one.
 *
 * Weighted heavily towards simply changing pose. Changing what she is doing
 * costs the user nothing and is the thing that makes her feel alive; speaking
 * unprompted interrupts, and also costs a request. One in four is enough to be
 * a pleasant surprise and rare enough not to become noise.
 */
export function pickActivity(random = Math.random): Activity {
  return random() < 0.25 ? "greeting" : "emote";
}

/** Records that something happened, for the daily cap. */
export function recordFired(state: AmbientState, now: Date): AmbientState {
  const rolled = rollDay(state, now);
  return { ...rolled, firedToday: rolled.firedToday + 1 };
}

/** Silences her for the rest of the current local day. */
export function muteToday(state: AmbientState, now: Date): AmbientState {
  return { ...rollDay(state, now), mutedDay: localDay(now) };
}

/** `"22:00"` for a settings field. */
export function formatMinute(minute: MinuteOfDay): string {
  const hours = `${Math.floor(minute / 60) % 24}`.padStart(2, "0");
  const minutes = `${minute % 60}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Parses `"22:00"`. Returns null for anything it cannot read. */
export function parseMinute(text: string): MinuteOfDay | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
