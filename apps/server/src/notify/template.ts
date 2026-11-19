/**
 * The little template language for notification wording.
 *
 *   {{title}}                    the value, or nothing if it has none
 *   {{#reason}}: {{reason}}{{/reason}}   only when reason has a value
 *   {{^reason}}.{{/reason}}       only when reason has no value
 *
 * Unknown names come out empty, so a typo never breaks a message.
 */

export type Vars = Record<string, string | number | boolean | null | undefined>;

const has = (v: Vars[string]) => v !== null && v !== undefined && v !== '' && v !== false;
const text = (v: Vars[string]) => (has(v) ? (v === true ? 'yes' : String(v)) : '');

const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const VAR = /\{\{\s*([\w.]+)\s*\}\}/g;

export function render(template: string, vars: Vars): string {
  let out = template;
  // Sections can sit inside sections, so keep going until none are left.
  for (let i = 0; i < 5 && SECTION.test(out); i++) {
    SECTION.lastIndex = 0;
    out = out.replace(SECTION, (_m, kind: string, name: string, inner: string) => ((kind === '#') === has(vars[name]) ? inner : ''));
  }
  return out.replace(VAR, (_m, name: string) => text(vars[name])).trim();
}

/** Names used in a template that the event doesn't have, so the editor can point them out. */
export function unknownNames(template: string, known: string[]): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*[#^/]?\s*([\w.]+)\s*\}\}/g)) names.add(m[1]!);
  return [...names].filter((n) => !known.includes(n));
}
