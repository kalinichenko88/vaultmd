export type TransformResult = {
  content: string | null;
  outcome: 'created' | 'updated' | 'unchanged';
};
