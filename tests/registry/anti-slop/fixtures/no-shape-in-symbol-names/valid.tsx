import { IconShapeCircle as CircleIcon } from "./icons";

function readMember(props: { id: string }): string {
  return props.shapeRendering;
}

function render() {
  return <svg shapeRendering="crispEdges" />;
}

const icon = CircleIcon;

export { readMember, render, icon };
