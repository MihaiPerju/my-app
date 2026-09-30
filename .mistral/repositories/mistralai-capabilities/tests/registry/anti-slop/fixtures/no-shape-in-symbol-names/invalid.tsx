import { IconShapeCircle } from "./icons";

const shapeOfThing = 1;

function makeShape(): number {
  return 2;
}

type ShapeInfo = { size: number };

class Box {
  #shape = 3;
}

function render() {
  return <ShapeBox />;
}

export { IconShapeCircle, shapeOfThing, makeShape, Box, render };
export type { ShapeInfo };
