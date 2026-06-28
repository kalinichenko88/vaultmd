export function matches(x: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (p === '') {
      return true;
    }
    if (x === p) {
      return true;
    }
    if (x.startsWith(`${p}/`)) {
      return true;
    }
  }

  return false;
}
