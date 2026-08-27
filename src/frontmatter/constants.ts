/**
 * Options for every `yaml` parse in this module (`Document.toJS` does not read
 * them — it uses the ones its document was parsed with).
 *
 * `logLevel: 'error'` silences the collection-as-map-key warning a template
 * placeholder triggers. Not `'silent'`: that also stops `parse` from throwing
 * on invalid YAML, which is how a block earns `'present-but-invalid'`.
 */
export const YAML_OPTIONS = { uniqueKeys: false, logLevel: 'error' } as const;
