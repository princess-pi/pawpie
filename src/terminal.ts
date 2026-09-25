// Shared by list.ts and cli.ts: ADR titles, sidecar text, and (for
// recheck/punch) judge notes and web-sourced evidence are all unvalidated
// free text that can carry a terminal escape sequence (e.g. OSC 52, which
// can write the invoking user's clipboard, or an 8-bit C1 equivalent of the
// same sequence). Strip C0 controls, DEL, and C1 controls (U+0080-U+009F)
// before any of it reaches a terminal via a text renderer.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitizeForTerminal(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}
