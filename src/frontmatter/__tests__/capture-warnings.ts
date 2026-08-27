/**
 * Run `fn` with `process.emitWarning` captured, and return everything yaml
 * (or anything else) tried to print to stderr.
 */
export function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = (w: string | Error) => {
    warnings.push(String(w));
  };
  try {
    fn();
  } finally {
    process.emitWarning = emitWarning;
  }

  return warnings;
}
