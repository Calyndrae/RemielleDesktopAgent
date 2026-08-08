/**
 * What she is told about the moment before she says something.
 *
 * Facts, not a script. Each entry is a short statement about now; the model is
 * asked to pick one or two and remark on them. That split is the whole design:
 * assembling a sentence here would produce a template, and a template is what
 * makes a companion feel like a toy the second time you see it.
 *
 * The rule for adding to this: it must be something *she could plausibly
 * notice*. She can see the clock and she can tell how long you have been away
 * from the keyboard. She cannot see your screen unless you have switched that
 * on, and she should never be told anything the user has not agreed to share.
 */

/** Roughly what part of the day it is, in words rather than a number. */
export function partOfDay(now: Date): string {
  const hour = now.getHours();
  // Bucketed on purpose. "14:37" invites a model to repeat the clock back at
  // you, which is a weather report rather than a remark.
  if (hour < 5) return "现在是深夜";
  if (hour < 9) return "现在是清晨";
  if (hour < 12) return "现在是上午";
  if (hour < 14) return "现在是中午";
  if (hour < 18) return "现在是下午";
  if (hour < 23) return "现在是晚上";
  return "现在快到半夜了";
}

/** How long the user has been away from the keyboard, in round terms. */
export function idlePhrase(idleMs: number): string | null {
  const minutes = Math.floor(idleMs / 60_000);
  // Under a few minutes is not absence, it is a pause for thought. Reporting it
  // would make her sound like she is watching the clock.
  if (minutes < 5) return null;
  if (minutes < 30) return `你大概 ${minutes} 分钟没动过键盘了`;
  if (minutes < 90) return "你有大半个小时没动静了";
  const hours = Math.floor(minutes / 60);
  return `你差不多 ${hours} 小时没动静了`;
}

/** Whether this is the first thing she has said today. */
export function firstTodayPhrase(firedToday: number): string | null {
  return firedToday === 0 ? "今天你们还没说过话" : null;
}

export interface FactInput {
  now: Date;
  idleMs: number;
  firedToday: number;
  /**
   * The foreground application, or null.
   *
   * Only ever populated when the user has `get_active_window` switched on. The
   * tool switch is the consent, and routing this through the same flag means
   * there is one place to say no rather than two.
   */
  activeApp: string | null;
}

/** Everything worth telling her, with the nothings dropped. */
export function buildFacts(input: FactInput): string[] {
  const facts = [partOfDay(input.now)];

  const idle = idlePhrase(input.idleMs);
  if (idle) facts.push(idle);

  const first = firstTodayPhrase(input.firedToday);
  if (first) facts.push(first);

  if (input.activeApp) facts.push(`你正开着 ${input.activeApp}`);

  return facts;
}
