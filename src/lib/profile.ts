/**
 * The "about you" block — what she is told about her person.
 *
 * Everything here is opt-in per field, composed fresh at send time, and never
 * stored anywhere except the local settings file the user already owns. The
 * design constraint from the handoff is the honest one: the settings screen
 * shows a live preview of *exactly* the text this function returns, so "what
 * does she know about me?" is answered by reading, not by trusting.
 */

export interface UserProfile {
  /** What she should call the user. */
  callMe: string;
  callMeOn: boolean;
  /** Free-form context the user chose to share. */
  about: string;
  aboutOn: boolean;
  /** Whether to mention the timezone (derived, never typed). */
  timezoneOn: boolean;
}

export const EMPTY_PROFILE: UserProfile = {
  callMe: "",
  callMeOn: false,
  about: "",
  aboutOn: false,
  timezoneOn: false,
};

/** About 500 CJK characters — context, not an autobiography. */
export const MAX_ABOUT_CHARS = 500;

/**
 * The block appended to the system prompt, or the empty string.
 *
 * Empty means empty: no header, no placeholder, nothing for a model to remark
 * on. A block that said "the user shared nothing" would itself be a fact she
 * was never given permission to have.
 */
export function composeProfileBlock(
  profile: UserProfile,
  timezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const lines: string[] = [];

  const callMe = profile.callMe.trim();
  if (profile.callMeOn && callMe) lines.push(`称呼对方：${callMe}`);

  if (profile.timezoneOn && timezone) lines.push(`对方所在时区：${timezone}`);

  const about = profile.about.trim();
  if (profile.aboutOn && about) {
    lines.push(`对方希望你知道的：${about.slice(0, MAX_ABOUT_CHARS)}`);
  }

  if (lines.length === 0) return "";
  return `[关于对方]\n${lines.join("\n")}`;
}
