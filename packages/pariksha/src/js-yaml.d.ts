// js-yaml 4 ships no declarations; this is the part pariksha and its tests call.
declare module 'js-yaml' {
  export interface LoadOptions {
    readonly schema?: unknown;
  }
  export const FAILSAFE_SCHEMA: unknown;
  /** YAML 1.2's core schema: no timestamps, merge keys or binary. */
  export const CORE_SCHEMA: unknown;
  /** Parses one YAML document; throws a YAMLException when it does not parse. */
  export function load(source: string, options?: LoadOptions): unknown;
  /** Parses every document in a stream; throws a YAMLException when one does not parse. */
  export function loadAll(source: string, iterator?: null, options?: LoadOptions): unknown[];
}
