/** Masks credential-shaped diagnostics before they reach logs or the renderer (R2). */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-(?:\.{3}|\u2026)?[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(["']?(?:(?:access|refresh|id)[_-]?token|ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|CLAUDE_CODE_OAUTH_TOKEN|x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[redacted]');
}

const MAX_STDERR_LINE = 16_384;
const OMITTED_LINE = '[stderr line omitted: exceeds safe diagnostic limit]';

/** Assemble records before redaction, so a token split across pipe chunks cannot leak. */
export class StderrLines {
  private pending = '';
  private dropping = false;

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: string): void {
    const lines = (this.pending + chunk).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      if (this.dropping) this.dropping = false;
      else this.onLine(line.length > MAX_STDERR_LINE ? OMITTED_LINE : line.replace(/\r$/, ''));
    }
    if (this.dropping) this.pending = '';
    else if (this.pending.length > MAX_STDERR_LINE) {
      this.pending = '';
      this.dropping = true;
      this.onLine(OMITTED_LINE);
    }
  }

  flush(): void {
    if (!this.dropping && this.pending) this.onLine(this.pending.replace(/\r$/, ''));
    this.pending = '';
    this.dropping = false;
  }
}
