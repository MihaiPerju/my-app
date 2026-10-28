import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/index.ts";

type ExpectedParagraphChild = {
  type: string;
  value?: string;
};

describe("math compatibility", () => {
  describe("Le Chat-focused cases", () => {
    it("parses parenthesized model-style inline math without a preprocessing pass", () => {
      const snapshot = parseMarkdown(
        "Let's consider the function \\( f(x) \\) for our example and \\([a, b]\\).",
      );

      expect(snapshot.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Let's consider the function ",
              },
              {
                type: "inlineMath",
                value: "f(x)",
              },
              {
                type: "text",
                value: " for our example and ",
              },
              {
                type: "inlineMath",
                value: "[a, b]",
              },
              {
                type: "text",
                value: ".",
              },
            ],
          },
        ],
      });
    });

    describe("legacy dollar golden corpus", () => {
      it.each([
        {
          name: "whitespace-separated currency stays literal",
          source: "The price is between 3 $ and 6 $ as of yesterday",
          children: [
            {
              type: "text",
              value: "The price is between 3 $ and 6 $ as of yesterday",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "a single price with a leading dollar stays literal",
          source: "Here is some price: $10.99",
          children: [
            {
              type: "text",
              value: "Here is some price: $10.99",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "a price range stays literal",
          source: "Here is some price: $10.99 - $20.99",
          children: [
            {
              type: "text",
              value: "Here is some price: $10.99 - $20.99",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "a tight integer price range stays literal",
          source: "Budget is $50-$200",
          children: [
            {
              type: "text",
              value: "Budget is $50-$200",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "a spaced integer price range with a repeated dollar stays literal",
          source: "Smartphone: $300 - $1,500",
          children: [
            {
              type: "text",
              value: "Smartphone: $300 - $1,500",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "an en-dash integer price range with a repeated dollar stays literal",
          source: "Smartphone: $300–$1,500",
          children: [
            {
              type: "text",
              value: "Smartphone: $300–$1,500",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "token pricing prose stays literal",
          source: "$16/hour / 4,207,320 tokens/hour = $0.000003803 per token",
          children: [
            {
              type: "text",
              value:
                "$16/hour / 4,207,320 tokens/hour = $0.000003803 per token",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "a price can appear before true inline math in the same sentence",
          source: "The total is $100 and the variable is $x$",
          children: [
            {
              type: "text",
              value: "The total is $100 and the variable is ",
            },
            {
              type: "inlineMath",
              value: "x",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "numeric inline math can still parse before a later price",
          source: "$1$ costs $2.50",
          children: [
            {
              type: "inlineMath",
              value: "1",
            },
            {
              type: "text",
              value: " costs $2.50",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
        {
          name: "parenthesized math can contain a literal dollar sign without a preprocessing pass",
          source: "Revenue was \\( R = 100 $ \\) for our example",
          children: [
            {
              type: "text",
              value: "Revenue was ",
            },
            {
              type: "inlineMath",
              value: "R = 100 $",
            },
            {
              type: "text",
              value: " for our example",
            },
          ] satisfies readonly ExpectedParagraphChild[],
        },
      ])("$name", ({ source, children }) => {
        expect(parseMarkdown(source).ast).toMatchObject({
          children: [
            {
              type: "paragraph",
              children,
            },
          ],
        });
      });
    });

    it.each([
      "The price moved from 72.99 $ on March 6 to 81.96 $ on March 11.",
      "Here is some price: 12$",
      "12$ + 10$",
    ])("keeps currency-like dollars literal: %s", (source) => {
      expect(parseMarkdown(source).ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: source,
              },
            ],
          },
        ],
      });
    });

    it("keeps currency-like dollars literal even when later real math appears in the same paragraph", () => {
      expect(parseMarkdown("price $10.99 and formula $m$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "price $10.99 and formula ",
              },
              {
                type: "inlineMath",
                value: "m",
              },
            ],
          },
        ],
      });
    });

    it.each([
      {
        source: "There:$y$.",
        children: [
          { type: "text", value: "There:" },
          { type: "inlineMath", value: "y" },
          { type: "text", value: "." },
        ],
      },
      {
        source: "$y$",
        children: [{ type: "inlineMath", value: "y" }],
      },
      {
        source: "Here is some simple latex: $1$",
        children: [
          { type: "text", value: "Here is some simple latex: " },
          { type: "inlineMath", value: "1" },
        ],
      },
      {
        source: "Here is some simple latex: $y$",
        children: [
          { type: "text", value: "Here is some simple latex: " },
          { type: "inlineMath", value: "y" },
        ],
      },
    ])("parses tight inline math from chat rendering: $source", (testCase) => {
      expect(parseMarkdown(testCase.source).ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: testCase.children,
          },
        ],
      });
    });

    it("preserves TeX environments inside bracketed display math", () => {
      const snapshot = parseMarkdown(
        "Here is some block:\n\\[\\begin{vmatrix}1 & 1 \\\\0 & 1 \\\\x & y\\end{vmatrix}= 0\\]",
      );

      expect(snapshot.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "Here is some block:" }],
          },
          {
            type: "math",
            value: "\\begin{vmatrix}1 & 1 \\\\0 & 1 \\\\x & y\\end{vmatrix}= 0",
          },
        ],
      });
    });

    it("preserves dollar signs inside bracketed display math", () => {
      const snapshot = parseMarkdown(
        "According to our calculations\n\\[ R = $70 + $30 \\]",
      );

      expect(snapshot.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "According to our calculations" },
            ],
          },
          {
            type: "math",
            value: " R = $70 + $30 ",
          },
        ],
      });
    });

    it("parses indented bracketed display math after blank lines", () => {
      const snapshot = parseMarkdown(
        [
          "It is calculated as:",
          "",
          "  \\[ ",
          "\\text{Precision} = ",
          "\\frac{\\text{True Positives}}{\\text{True Positives} ",
          "+ \\text{False Positives}} ",
          "\\]",
          "",
          "- **Recall**",
        ].join("\n"),
      );

      expect(snapshot.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "It is calculated as:" }],
          },
          {
            type: "math",
            value:
              "\\text{Precision} = \n\\frac{\\text{True Positives}}{\\text{True Positives} \n+ \\text{False Positives}} \n",
          },
          {
            type: "list",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "strong",
                        children: [{ type: "text", value: "Recall" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("closes bracketed display math with an indented closing delimiter after a list item", () => {
      const snapshot = parseMarkdown(
        [
          "Here's how you can calculate NDCG in this scenario:",
          "",
          "1. **Discounted Cumulative Gain (DCG):**",
          "   - For a single relevant item at position \\( p \\), the DCG is calculated as:",
          "\\[",
          "\\text{DCG}_p = \\frac{1}{\\log_2(p + 1)}",
          "     \\]",
          "",
          "2. **Ideal Discounted Cumulative Gain (IDCG):**",
        ].join("\n"),
      );

      expect(snapshot.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Here's how you can calculate NDCG in this scenario:",
              },
            ],
          },
          {
            type: "list",
            ordered: true,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "strong",
                        children: [
                          {
                            type: "text",
                            value: "Discounted Cumulative Gain (DCG):",
                          },
                        ],
                      },
                    ],
                  },
                  {
                    type: "list",
                    children: [
                      {
                        type: "listItem",
                        children: [
                          {
                            type: "paragraph",
                            children: [
                              {
                                type: "text",
                                value:
                                  "For a single relevant item at position ",
                              },
                              { type: "inlineMath", value: "p" },
                              {
                                type: "text",
                                value: ", the DCG is calculated as:",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "math",
            value: "\\text{DCG}_p = \\frac{1}{\\log_2(p + 1)}\n",
          },
          {
            type: "list",
            ordered: true,
            start: 2,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "strong",
                        children: [
                          {
                            type: "text",
                            value: "Ideal Discounted Cumulative Gain (IDCG):",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("keeps parenthesized and bracketed math delimiters literal inside inline code", () => {
      expect(parseMarkdown("Use `\\(x\\)` and `\\[y\\]`.").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "Use " },
              { type: "inlineCode", value: "\\(x\\)" },
              { type: "text", value: " and " },
              { type: "inlineCode", value: "\\[y\\]" },
              { type: "text", value: "." },
            ],
          },
        ],
      });
    });

    it("keeps parenthesized and bracketed math delimiters literal inside fenced code", () => {
      expect(parseMarkdown("```md\n\\[x\\]\n\\(y\\)\n```").ast).toMatchObject({
        children: [
          {
            type: "code",
            lang: "md",
            value: "\\[x\\]\n\\(y\\)",
          },
        ],
      });
    });

    it("closes dollar display math with an indented closing delimiter", () => {
      expect(parseMarkdown("$$\nx\n     $$\nAfter").ast).toMatchObject({
        children: [
          {
            type: "math",
            value: "x\n",
          },
          {
            type: "paragraph",
            children: [{ type: "text", value: "After" }],
          },
        ],
      });
    });

    it("closes bracketed display math with trailing whitespace on the closing delimiter", () => {
      expect(parseMarkdown("\\[\nx\n     \\]\t  \nAfter").ast).toMatchObject({
        children: [
          {
            type: "math",
            value: "x\n",
          },
          {
            type: "paragraph",
            children: [{ type: "text", value: "After" }],
          },
        ],
      });
    });

    it("keeps the next list item outside bracketed display math without a blank line", () => {
      expect(
        parseMarkdown(
          ["1. First", "\\[", "x", "     \\]", "2. Second"].join("\n"),
        ).ast,
      ).toMatchObject({
        children: [
          {
            type: "list",
            ordered: true,
            start: 1,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "First" }],
                  },
                ],
              },
            ],
          },
          {
            type: "math",
            value: "x\n",
          },
          {
            type: "list",
            ordered: true,
            start: 2,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "Second" }],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("closes bracketed display math inside block quotes with an indented closing delimiter", () => {
      expect(
        parseMarkdown("> \\[\n> x\n>      \\]\n> After").ast,
      ).toMatchObject({
        children: [
          {
            type: "blockquote",
            children: [
              {
                type: "math",
                value: "x\n",
              },
              {
                type: "paragraph",
                children: [{ type: "text", value: "After" }],
              },
            ],
          },
        ],
      });
    });

    it("treats a standalone indented bracketed closer as a delimiter", () => {
      expect(parseMarkdown("\\[\nx\n  \\]\ny\n\\]").ast).toMatchObject({
        children: [
          {
            type: "math",
            value: "x\n",
          },
          {
            type: "paragraph",
            children: [{ type: "text", value: "y\n]" }],
          },
        ],
      });
    });
  });

  describe("selected upstream remark-math ecosystem cases", () => {
    it("keeps an escaped opening dollar sign literal", () => {
      expect(parseMarkdown("\\$\\alpha$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "$\\alpha$" }],
          },
        ],
      });
    });

    it("allows inline math after an escaped literal dollar sign", () => {
      expect(parseMarkdown("a \\$$b$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "a $" },
              { type: "inlineMath", value: "b" },
            ],
          },
        ],
      });
    });

    it("allows an escaped escape before an inline-math opener", () => {
      expect(parseMarkdown("\\\\$\\alpha$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "\\" },
              { type: "inlineMath", value: "\\alpha" },
            ],
          },
        ],
      });
    });

    it("keeps dollars inside inline code from opening math", () => {
      expect(parseMarkdown("`$`\\alpha$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "inlineCode", value: "$" },
              { type: "text", value: "\\alpha$" },
            ],
          },
        ],
      });
    });

    it("allows backticks inside inline math payloads", () => {
      expect(parseMarkdown("$`\\alpha`$").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "inlineMath", value: "`\\alpha`" }],
          },
        ],
      });
    });

    it("keeps multiline inline dollar math literal", () => {
      expect(parseMarkdown("a $b\nc$ f").ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "a $b\nc$ f" }],
          },
        ],
      });
    });

    it("supports display math inside block quotes", () => {
      expect(parseMarkdown("> $$\n> a\n> $$\n> b").ast).toMatchObject({
        children: [
          {
            type: "blockquote",
            children: [
              {
                type: "math",
                value: "a\n",
              },
              {
                type: "paragraph",
                children: [{ type: "text", value: "b" }],
              },
            ],
          },
        ],
      });
    });

    it("supports display math inside list items", () => {
      expect(parseMarkdown("* $$\n  a\n  $$\n  b").ast).toMatchObject({
        children: [
          {
            type: "list",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "math",
                    value: "a\n",
                  },
                  {
                    type: "paragraph",
                    children: [{ type: "text", value: "b" }],
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it.each([
      {
        source: "> $$\na\n$$",
        expectedChildren: [
          {
            type: "blockquote",
            children: [{ type: "math", value: "" }],
          },
          {
            type: "paragraph",
            children: [{ type: "text", value: "a" }],
          },
          {
            type: "math",
            value: "",
          },
        ],
      },
      {
        source: "> $$\n> a\n$$",
        expectedChildren: [
          {
            type: "blockquote",
            children: [{ type: "math", value: "a\n" }],
          },
          {
            type: "math",
            value: "",
          },
        ],
      },
      {
        source: "a\n> $$",
        expectedChildren: [
          {
            type: "paragraph",
            children: [{ type: "text", value: "a" }],
          },
          {
            type: "blockquote",
            children: [{ type: "math", value: "" }],
          },
        ],
      },
    ])(
      "does not allow lazy continuation for math fences: $source",
      (testCase) => {
        expect(parseMarkdown(testCase.source).ast).toMatchObject({
          children: testCase.expectedChildren,
        });
      },
    );

    it("supports empty display math blocks", () => {
      expect(parseMarkdown("$$\n$$").ast).toMatchObject({
        children: [{ type: "math", value: "" }],
      });
    });

    it("preserves angle brackets inside inline math payloads", () => {
      expect(
        parseMarkdown("a $\\sum_{\\substack{0<i<m\\\\0<j<n}}$ b").ast,
      ).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "a " },
              {
                type: "inlineMath",
                value: "\\sum_{\\substack{0<i<m\\\\0<j<n}}",
              },
              { type: "text", value: " b" },
            ],
          },
        ],
      });
    });

    it("preserves escaped quotes inside inline math payloads", () => {
      expect(parseMarkdown('a $\\text{a \\"{a} c}$ b').ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "a " },
              {
                type: "inlineMath",
                value: '\\text{a \\"{a} c}',
              },
              { type: "text", value: " b" },
            ],
          },
        ],
      });
    });

    it.each(["a $$b$$ c", "a $$$b$$$ c"])(
      "does not treat multi-dollar inline runs as inline math: %s",
      (source) => {
        expect(parseMarkdown(source).ast).toMatchObject({
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", value: source }],
            },
          ],
        });
      },
    );

    it.each([
      {
        source: "\\begin{equation}\na+b\n\\end{equation}\n",
        value: "\\begin{equation}\na+b\n\\end{equation}",
      },
      {
        source: "\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}\n",
        value: "\\begin{align}\na&=b\\\nc&=d\n\\end{align}",
      },
    ])(
      "keeps bare TeX environments literal when they are not wrapped in supported math delimiters",
      (testCase) => {
        expect(parseMarkdown(testCase.source).ast).toMatchObject({
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  value: testCase.value,
                },
              ],
            },
          ],
        });
      },
    );
  });
});
