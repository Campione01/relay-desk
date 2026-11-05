import type { NativePanel, NativePanelInput } from '@shared/types';
import { detectNativePanel, encodeNativePanelInput, nativePanelPayload } from './panel';
import type { NativeTerminalScreen } from './terminalScreen';

export interface NativePanelHostOptions {
  screen: NativeTerminalScreen;
  publish(panel: NativePanel | null): void;
  writeTerminal(data: string): Promise<void>;
  /** The slash command the user is running, while it is pending. */
  pendingCommand(): string | undefined;
  /** A failed Relay control left a native dialog that only the user can now see and close. */
  recovering(): boolean;
  /** Relay itself is driving a native dialog (model, effort, MCP reads); those are never mirrored. */
  driving(): boolean;
  onVisible?(visible: boolean): void;
  throttleMs?: number;
}

const CLOSE_ATTEMPTS = 6;
const CLOSE_WAIT_MS = 1_500;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mirrors the native dialog of a user command (or of a failed control) and carries input back to it. */
export class NativePanelHost {
  private readonly options: NativePanelHostOptions;
  private shown: NativePanel | undefined;
  private shownKey = '';
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private disposed = false;

  constructor(options: NativePanelHostOptions) { this.options = options; }

  get visible(): boolean { return Boolean(this.shown); }
  get panel(): NativePanel | undefined { return this.shown; }

  /** Terminal output arrived (the screen already holds it). */
  observe(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.evaluate(); }, this.options.throttleMs ?? 40);
  }

  /** Ownership changed (a command started or settled, a control failed or recovered): decide at once. */
  refresh(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.evaluate();
  }

  input(input: NativePanelInput): Promise<void> {
    const run = this.writes.then(() => {
      const region = this.ownedRegion();
      if (!region || !this.shown) throw new Error('No CLI panel is open.');
      const screen = this.options.screen;
      const bytes = encodeNativePanelInput(input, { mouse: screen.mouse, bracketedPaste: screen.bracketedPaste,
        firstRow: region.firstRow, rowCount: region.lastRow - region.firstRow + 1, columns: screen.columns });
      return this.options.writeTerminal(bytes);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** Esc until the dialog is gone: nested views (a search, a sub-page) need more than one. */
  close(): Promise<void> {
    this.closing ??= this.writes.then(async () => {
      for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt++) {
        if (this.disposed || !this.ownedRegion()) return;
        const before = this.options.screen.visualRevision;
        await this.options.writeTerminal('\x1b');
        const deadline = Date.now() + CLOSE_WAIT_MS;
        while (Date.now() < deadline && !this.disposed && this.ownedRegion() && this.options.screen.visualRevision === before) await delay(25);
        await delay(80);
      }
      if (!this.disposed && this.ownedRegion()) throw new Error('The CLI panel did not close.');
    }).finally(() => { this.closing = undefined; this.refresh(); });
    return this.closing;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.shown) { this.shown = undefined; this.shownKey = ''; this.options.publish(null); this.options.onVisible?.(false); }
  }

  private ownedRegion() {
    if (this.options.driving()) return undefined;
    if (!this.options.pendingCommand() && !this.options.recovering()) return undefined;
    return detectNativePanel(this.options.screen);
  }

  private evaluate(): void {
    if (this.disposed) return;
    const region = this.ownedRegion();
    if (!region) {
      if (!this.shown) return;
      this.shown = undefined; this.shownKey = '';
      this.options.publish(null);
      this.options.onVisible?.(false);
      return;
    }
    const next = nativePanelPayload(this.options.screen, region, this.revision + 1, this.options.pendingCommand());
    const key = JSON.stringify([next.command, next.columns, next.mouse, next.rows, next.styles]);
    if (key === this.shownKey) return;
    const appeared = !this.shown;
    this.revision = next.revision;
    this.shown = next; this.shownKey = key;
    this.options.publish(next);
    if (appeared) this.options.onVisible?.(true);
  }
}
