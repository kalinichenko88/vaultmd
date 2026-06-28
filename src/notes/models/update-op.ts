export type UpdateOp =
  | { editByMatch: { old: string; new: string } }
  | { append: string };
