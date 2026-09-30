import type { Data, Literal } from "mdast";

declare module "mdast" {
  interface Math extends Literal {
    type: "math";
    meta?: string | null | undefined;
    data?: Data | undefined;
  }

  interface InlineMath extends Literal {
    type: "inlineMath";
    data?: Data | undefined;
  }

  interface BlockContentMap {
    math: Math;
  }

  interface PhrasingContentMap {
    inlineMath: InlineMath;
  }

  interface RootContentMap {
    inlineMath: InlineMath;
    math: Math;
  }
}
