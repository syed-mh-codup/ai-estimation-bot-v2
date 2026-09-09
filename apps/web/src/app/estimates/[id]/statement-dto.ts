/**
 * One narrative line or assumption as the editor renders it — AEH-238.
 *
 * Its own module for the reason `lock-dto.ts` has one: `EditableList` is a
 * client component, and a type imported from anywhere that touches Prisma
 * drags the client into the browser bundle. Typecheck stays green on that; the
 * build does not. See AEH-253.
 *
 * `id` is nullable, and that is the one thing to understand here. A line
 * somebody has just added exists on screen before it exists as a row, and until
 * the save comes back there is nothing to lock, tick or address. Rendering it
 * with `id: null` says so honestly rather than inventing a temporary handle that
 * the server would not recognise.
 */
export type StatementDTO = {
  /** `EstimateStatement.id`, or null for a line not yet saved. */
  id: string | null;
  text: string;
  /** CREW wrote it, a person typed it, or the Scribe rewrote it under a steer. */
  provenance: 'CREW' | 'HUMAN' | 'STEERED';
};
