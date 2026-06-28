import type { LinkResolution } from '../../links/index.ts';

// Row-semantics-affecting config (fingerprinted): a change to any field
// invalidates the derived index and forces a rebuild.
export type IndexConfig = {
  linkResolution: LinkResolution;
  caseSensitive: boolean;
  ignore: string[];
};
