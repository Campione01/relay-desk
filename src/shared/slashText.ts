/**
 * Sends that begin with "/". The CLI's Mod host refuses `$.prompt.submit` for any text whose trimStart() begins with
 * "/" (it would run a command as the user), and attachment sends refuse such text as a terminal command, so Relay
 * routes a text-only command, sends a pasted drive path without its "/", and refuses the rest before sending. Shared
 * by the renderer and main so both decide the same way.
 */

/** The host rule: JS `\s` is the set trimStart() removes. */
const HOST_SLASH_TEXT = /^\s*\//;
/** A pasted Windows drive path such as `/E:/x` or `/E:\x`, the CLI prompt-box habit. */
const DRIVE_PATH = /^\s*\/(?=[A-Za-z]:[\\/])/;

/** Main's refusal; the renderer maps it to its own note. */
export const SLASH_TEXT_REFUSAL = 'Relay did not send this message: text that starts with "/" runs as a CLI command. Remove the leading "/" to send it as a message.';

/** A drive path loses its leading blanks and "/" (`/E:/x` becomes `E:/x`); any other text is returned unchanged. */
export function withoutDriveSlash(text: string): string {
  return text.replace(DRIVE_PATH, '');
}

/** Whether the CLI host would refuse this text as a model prompt. */
export function startsWithSlash(text: string): boolean {
  return HOST_SLASH_TEXT.test(text);
}
