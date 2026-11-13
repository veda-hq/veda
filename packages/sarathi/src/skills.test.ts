/**
 * The working-rules skill: a plugin skill and a file a project's CLAUDE.md
 * imports from the installed package, so both readers must find it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('skills/working-rules/SKILL.md', () => {
  const text = read('skills/working-rules/SKILL.md');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);

  it('opens with the frontmatter a plugin skill needs', () => {
    const block = front?.[1];
    assert.ok(block !== undefined, 'SKILL.md starts with a --- frontmatter block');
    const fields = new Map(
      block.split('\n').map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
      }),
    );
    assert.deepEqual([...fields.keys()].sort(), ['description', 'name']);
    assert.equal(fields.get('name'), 'working-rules');
    const description = fields.get('description') ?? '';
    assert.ok(description.length > 40 && description.length <= 1024);
  });

  it('carries the rules a project relies on being loaded', () => {
    for (const rule of [/runs to merge/i, /--no-verify/, /in the background/, /Resolve a thread only after its fix is on the remote/, /## Stop and ask when/, /a new dependency/]) {
      assert.match(text, rule);
    }
  });

  it('ships in the package', () => {
    const files = (JSON.parse(read('package.json')) as { files: string[] }).files;
    assert.ok(files.includes('skills'), 'package.json files lists skills');
  });
});
