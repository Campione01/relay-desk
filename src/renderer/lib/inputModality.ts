let keyboard = false;
let installed = false;

/** Tracks whether the last user input was a key press, so menus opened by mouse start without a highlight. */
export function installInputModality(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', () => {
    keyboard = true;
  }, true);
  window.addEventListener('pointerdown', () => {
    keyboard = false;
  }, true);
}

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
