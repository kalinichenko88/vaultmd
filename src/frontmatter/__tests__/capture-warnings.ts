/**
 * Run `fn` with `process.emitWarning`/`console.warn` captured, and return
 * everything yaml (or anything else) tried to print. Both channels matter:
 * yaml's logger falls back to `console.warn` where `emitWarning` is missing.
 */
export function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const emitWarning = process.emitWarning;
  const consoleWarn = console.warn;
  process.emitWarning = (w: string | Error) => {
    warnings.push(String(w));
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    process.emitWarning = emitWarning;
    console.warn = consoleWarn;
  }

  return warnings;
}
