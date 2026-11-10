// js-yaml 4 ships no declarations; this is the one function pariksha calls.
declare module 'js-yaml' {
  /** Parses one YAML document; throws a YAMLException when it does not parse. */
  export function load(source: string): unknown;
}
