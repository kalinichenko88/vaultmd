import type { DocumentOptions, ParseOptions } from 'yaml';

/**
 * Options for every `yaml` PARSE in this module — `parse` and `parseDocument`.
 * `Document.toJS` does not read them: it takes the options its document was
 * parsed with, so the `parseDocument` call is the only place they apply.
 *
 * `uniqueKeys: false` — a note may legally repeat a key; every reader here is
 * last-wins rather than a throw.
 *
 * `logLevel: 'error'` — yaml prints a warning to stderr when a collection is
 * used as a map key (an unrendered `{{DATE:...}}` template placeholder parses
 * as one), advising `mapAsMap: true`, which is advice for this call site, not
 * for the consuming app. The shape is already reported through
 * `FrontmatterValidity`. `'error'` and not `'silent'`: silent also stops
 * `parse` from throwing on invalid YAML, which is how a block earns
 * `'present-but-invalid'`.
 */
export const YAML_OPTIONS: ParseOptions & DocumentOptions = {
  uniqueKeys: false,
  logLevel: 'error',
};
