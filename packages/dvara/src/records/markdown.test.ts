import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type MarkdownDoc,
  fenceKind,
  group,
  parseMarkdown,
} from "./markdown.ts";

const F = "```";

/** Each fence as [open, close, lang]. */
const spans = (doc: MarkdownDoc): [number, number, string][] =>
  doc.fences.map((f) => [f.open, f.close, f.lang]);

/** The 1-based lines a fence holds. */
const fenced = (doc: MarkdownDoc): number[] =>
  doc.inFence.flatMap((v, n) => (v ? [n] : []));

/** Each fence's body texts. */
const bodies = (doc: MarkdownDoc): string[][] =>
  doc.fences.map((f) => f.body.map((l) => l.text));

/**
 * The document under LF and CRLF reads alike: the same fences, bodies and
 * in-fence lines, so a finding names the same line either way.
 */
const read = (text: string): MarkdownDoc => {
  const doc = parseMarkdown(text);
  const crlf = parseMarkdown(text.replaceAll("\n", "\r\n"));
  assert.deepEqual(
    crlf.fences,
    doc.fences,
    `CRLF fences of ${JSON.stringify(text)}`,
  );
  assert.deepEqual(
    crlf.inFence,
    doc.inFence,
    `CRLF lines of ${JSON.stringify(text)}`,
  );
  return doc;
};

describe("markdown model: fences", () => {
  it("reads fences of either marker after frontmatter", () => {
    const doc = read(
      `---\na: 1\n---\n# T\n~~~text\n# not a heading\n~~~\n## S\n${F}\nunclosed`,
    );
    assert.deepEqual(spans(doc), [
      [5, 7, "text"],
      [9, 10, ""],
    ]);
    assert.deepEqual(fenced(doc), [5, 6, 7, 9, 10]);
  });

  it("reads a fence inside a blockquote, and ends it with the quote", () => {
    const doc = read(
      `> ${F}text\n> $ run\n> out\n> ${F}\n\n> ${F}text\n> x\nplain\n`,
    );
    assert.deepEqual(spans(doc), [
      [1, 4, "text"],
      [6, 7, "text"],
    ]);
    assert.deepEqual(bodies(doc)[0], ["$ run", "out"]);
    assert.equal(doc.inFence[8], false);
  });

  it("reads an inline code span as prose, not an open fence", () => {
    const doc = read(`# T\n${F}example${F}\n## S\n~~~a\`b\nx\n~~~`);
    // A tilde opener's info string may hold a backtick (CommonMark).
    assert.deepEqual(spans(doc), [[4, 6, "a`b"]]);
    assert.deepEqual(spans(read(`${F}x${F} y\n# h`)), []);
  });

  it("reads CommonMark containers: a fence in a list item, none in HTML", () => {
    const doc = read(
      "- item\n\n    ```ts\n    a\n    ```\n\n<!--\n```\nb\n```\n-->\n# H\n",
    );
    assert.deepEqual(spans(doc), [[3, 5, "ts"]]);
    assert.deepEqual(doc.fences[0]?.body, [{ n: 4, text: "    a" }]);
    assert.deepEqual(fenced(doc), [3, 4, 5]);
  });

  it("ends an unclosed fence with its list item, its quote, or the document", () => {
    assert.deepEqual(
      read("- ```\n  x\n- y\n").fences.map((f) => [f.open, f.close]),
      [[1, 2]],
    );
    assert.deepEqual(
      read("```\nopen\n\n").fences.map((f) => [f.open, f.close]),
      [[1, 4]],
    );
    const quoted = read("> ```ts\n> x\n\n# after");
    assert.deepEqual(spans(quoted), [[1, 2, "ts"]]);
    assert.deepEqual(bodies(quoted), [["x"]]);
    assert.deepEqual(fenced(quoted), [1, 2]);
  });

  it("keeps a closer-shaped line indented as body text in the body", () => {
    const doc = read("```\na\n    ```");
    assert.deepEqual(spans(doc), [[1, 3, ""]]);
    assert.deepEqual(bodies(doc), [["a", "    ```"]]);
    // A closer indented three spaces closes; four is body text.
    const three = read("```\nx\n   ```\n# y");
    assert.deepEqual(spans(three), [[1, 3, ""]]);
    assert.deepEqual(bodies(three), [["x"]]);
    assert.equal(three.inFence[4], false);
    const four = read("```\nx\n    ```\n# y");
    assert.deepEqual(spans(four), [[1, 4, ""]]);
    assert.deepEqual(bodies(four), [["x", "    ```", "# y"]]);
  });

  it("reads a lone CR as a space, so line numbers and columns hold", () => {
    const plain = parseMarkdown("a\rb\n# H\n");
    assert.deepEqual(plain.fences, []);
    assert.equal(plain.lines.length, 3);
    // The CR keeps its column: the marker after it is where mdast says.
    const doc = parseMarkdown("\r```\nx\n```");
    assert.deepEqual(
      doc.fences.map((f) => [f.open, f.close]),
      [[1, 3]],
    );
  });

  it("closes a fence whose body ends blank", () => {
    for (const [text, closer] of [
      ["```\na\n\n```\n# H\n", 4],
      ["```\na\n\n\n```\n# H\n", 5],
      ["```\n\n```\n# H\n", 3],
      ["```\n\n\n```\n# H\n", 4],
      ["```\na\n \n```\n# H\n", 4],
      ["> ```\n> a\n>\n> ```\n# H\n", 4],
      ["- ```\n  a\n\n  ```\n# H\n", 4],
    ] as const) {
      const doc = read(text);
      assert.deepEqual(
        doc.fences.map((f) => [f.open, f.close]),
        [[1, closer]],
        JSON.stringify(text),
      );
      assert.equal(doc.inFence[closer + 1], false, JSON.stringify(text));
    }
  });

  it("reads an empty fence as closed, with no body", () => {
    const doc = read("```\n```\n# H\n");
    assert.deepEqual(doc.fences, [{ open: 1, close: 2, lang: "", body: [] }]);
    assert.equal(doc.inFence[3], false);
  });

  it("unquotes a fence in a quote nested past three spaces into a list", () => {
    const doc = read(
      "- a\n  - b\n\n    > ```console\n    > $ git log\n    > ```\n",
    );
    assert.deepEqual(spans(doc), [[4, 6, "console"]]);
    assert.deepEqual(doc.fences[0]?.body, [{ n: 5, text: "$ git log" }]);
  });

  it("unquotes a body only as deep as the quotes holding the fence", () => {
    assert.deepEqual(read("```\n> kept\n```").fences[0]?.body, [
      { n: 2, text: "> kept" },
    ]);
    assert.deepEqual(read("> > ```\n> > x\n> > ```").fences[0]?.body, [
      { n: 2, text: "x" },
    ]);
    assert.deepEqual(read(`> ${F}text\n> > nested\n> ${F}\n`).fences[0]?.body, [
      { n: 2, text: "> nested" },
    ]);
  });

  it("closes a quoted fence on a quoted closer, a bare `>` quoting a blank", () => {
    const doc = read("> ~~~\n>\n> ~~~\nx");
    assert.deepEqual(spans(doc), [[1, 3, ""]]);
    assert.deepEqual(bodies(doc), [[""]]);
    assert.equal(doc.inFence[4], false);
    const tight = read(">```sh\n>a\n>```\n");
    assert.deepEqual(spans(tight), [[1, 3, "sh"]]);
    assert.deepEqual(bodies(tight), [["a"]]);
  });

  it("does not close a list fence on a closer that leaves the list item", () => {
    // Line 3 ends the item at its first column and opens a fence of its own.
    const doc = read("- ```\n  x\n```\n");
    assert.deepEqual(
      doc.fences.map((f) => [f.open, f.close]),
      [
        [1, 2],
        [3, 4],
      ],
    );
  });

  it("skips an indented code block", () => {
    assert.deepEqual(read("Title\n=====\n\n    ```\n    x\n").fences, []);
    assert.deepEqual(read("para\n\n    code\n").fences, []);
  });

  it("marks a fence opener, its body and its closer as in the fence", () => {
    const doc = read(`a\n${F}text\nb\n${F}\nc`);
    assert.deepEqual(doc.inFence.slice(1), [false, true, true, true, false]);
  });

  it("ends an unclosed fence at the last line, with no line past it", () => {
    const doc = read(`# T\n${F}\nx\ny`);
    assert.deepEqual(doc.fences, [
      {
        open: 2,
        close: 4,
        lang: "",
        body: [
          { n: 3, text: "x" },
          { n: 4, text: "y" },
        ],
      },
    ]);
    assert.equal(doc.inFence.length, 5);
    assert.deepEqual(spans(read("```ts\nx\n\n")), [[1, 4, "ts"]]);
  });

  it("reads a heading-shaped line inside a fence as its body", () => {
    const doc = read("```\n# not\n```\n# yes");
    assert.deepEqual(spans(doc), [[1, 3, ""]]);
    assert.deepEqual(bodies(doc), [["# not"]]);
    assert.equal(doc.inFence[4], false);
  });

  it("closes only on the opener's character, at least as long, alone", () => {
    for (const [text, close, body] of [
      // A tilde closes no backtick fence, nor a backtick a tilde one.
      ["```\nx\n~~~\n", 4, ["x", "~~~", ""]],
      ["~~~\nx\n```\n", 4, ["x", "```", ""]],
      // A shorter closer is body text; a longer one closes.
      ["````\nx\n```\n", 4, ["x", "```", ""]],
      ["```\nx\n`````\n", 3, ["x"]],
      ["~~~\nx\n~~~~\n", 3, ["x"]],
      // A closer with trailing text is body text; trailing space is not text.
      ["```\nx\n``` x\n", 4, ["x", "``` x", ""]],
      ["```\nx\n```  \n", 3, ["x"]],
    ] as const) {
      const doc = read(text);
      assert.deepEqual(
        doc.fences.map((f) => [f.open, f.close]),
        [[1, close]],
        JSON.stringify(text),
      );
      assert.deepEqual(bodies(doc), [body], JSON.stringify(text));
    }
  });

  it("reads an opener indented up to three spaces, keeping the body's indent", () => {
    for (const pad of [" ", "  ", "   "]) {
      const doc = read(`p\n\n${pad}\`\`\`\n${pad}x\n${pad}\`\`\`\nq\n`);
      assert.deepEqual(spans(doc), [[3, 5, ""]], JSON.stringify(pad));
      assert.deepEqual(bodies(doc), [[`${pad}x`]], JSON.stringify(pad));
    }
  });

  it("reads the info string's first word, lower-cased", () => {
    for (const [info, lang] of [
      ["", ""],
      ["ts", "ts"],
      ["TS", "ts"],
      [" sh ", "sh"],
      ["json type=X nocheck", "json"],
    ] as const)
      assert.deepEqual(
        read(`${F}${info}\nx\n${F}\n`).fences.map((f) => f.lang),
        [lang],
        info,
      );
  });
});

describe("markdown model: frontmatter", () => {
  it("is never in a fence, and the fences after it keep their lines", () => {
    const doc = read("---\na: 1\nb: 2\n---\n```\nx\n```\n");
    assert.deepEqual(spans(doc), [[5, 7, ""]]);
    assert.deepEqual(doc.fences[0]?.body, [{ n: 6, text: "x" }]);
    assert.deepEqual(fenced(doc), [5, 6, 7]);
    // A fence marker inside the frontmatter opens nothing.
    const inside = read("---\n```\n---\nx\n");
    assert.deepEqual(inside.fences, []);
    assert.deepEqual(fenced(inside), []);
    assert.deepEqual(read("---\ntitle: a\n---\n# h").fences, []);
  });

  it("is none without a closing marker: the text is Markdown from line 1", () => {
    const doc = read("---\na: 1\n```\nx\n```\n");
    assert.deepEqual(spans(doc), [[3, 5, ""]]);
    assert.deepEqual(read("---\ntitle: x\n\nbody").fences, []);
  });

  it("is read only from the first line", () => {
    const doc = read("x\n---\n```\ny\n```\n---\n");
    assert.deepEqual(spans(doc), [[3, 5, ""]]);
  });
});

describe("fence kinds", () => {
  it("names each info string's kind", () => {
    for (const [lang, kind] of [
      ["sh", "script"],
      ["bash", "script"],
      ["zsh", "script"],
      ["shell", "script"],
      ["", "transcript"],
      ["text", "transcript"],
      ["txt", "transcript"],
      ["console", "transcript"],
      ["shell-session", "transcript"],
      ["output", "transcript"],
      ["log", "transcript"],
      ["plaintext", "transcript"],
      ["ts", "source"],
      ["json", "source"],
      ["md", "source"],
    ] as const)
      assert.equal(fenceKind({ lang }), kind, lang);
  });
});

describe("group", () => {
  it("is a group's text, or '' when it did not take part", () => {
    const match = /(a)|(b)/.exec("b");
    assert.ok(match !== null);
    assert.equal(group(match, 1), "");
    assert.equal(group(match, 2), "b");
    assert.equal(group(match, 0), "b");
  });
});
