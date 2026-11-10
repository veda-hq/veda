// js-yaml 4 ships no types; this is the part doc-identifiers.ts and its tests use.
declare module 'js-yaml' {
  export interface LoadOptions {
    readonly schema?: unknown;
  }
  export const FAILSAFE_SCHEMA: unknown;
  export function load(text: string, options?: LoadOptions): unknown;
}
