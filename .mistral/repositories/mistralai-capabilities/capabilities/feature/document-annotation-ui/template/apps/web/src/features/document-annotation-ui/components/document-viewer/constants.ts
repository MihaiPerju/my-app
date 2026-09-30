export const COLOR_SCHEMES = {
  cyan: {
    fill: "bg-badge-cyan/90",
    accent: "bg-basic-cyan-accent",
    border: "border-basic-cyan-accent",
    text: "text-basic-cyan-subtle",
  },
  sky: {
    fill: "bg-badge-sky",
    accent: "bg-basic-blue-accent",
    border: "border-basic-blue-accent",
    text: "text-basic-blue-subtle",
  },
  emerald: {
    fill: "bg-badge-emerald",
    accent: "bg-basic-emerald-accent",
    border: "border-basic-emerald-accent",
    text: "text-basic-emerald-subtle",
  },
  purple: {
    fill: "bg-badge-purple",
    accent: "bg-basic-purple-accent",
    border: "border-basic-purple-accent",
    text: "text-basic-purple-subtle",
  },
  yellow: {
    fill: "bg-badge-yellow",
    accent: "bg-basic-yellow-accent",
    border: "border-basic-yellow-accent",
    text: "text-basic-yellow-subtle",
  },
  rose: {
    fill: "bg-badge-rose",
    accent: "bg-basic-rose-accent",
    border: "border-basic-rose-accent",
    text: "text-basic-rose-subtle",
  },
  orange: {
    fill: "bg-badge-orange",
    accent: "bg-basic-orange-accent",
    border: "border-basic-orange-accent",
    text: "text-basic-orange-subtle",
  },
  teal: {
    fill: "bg-badge-teal",
    accent: "bg-basic-teal-accent",
    border: "border-basic-teal-accent",
    text: "text-basic-teal-subtle",
  },
  pink: {
    fill: "bg-badge-pink",
    accent: "bg-basic-pink-accent",
    border: "border-basic-pink-accent",
    text: "text-basic-pink-subtle",
  },
  green: {
    fill: "bg-badge-green",
    accent: "bg-basic-green-accent",
    border: "border-basic-green-accent",
    text: "text-basic-green-subtle",
  },
  lime: {
    fill: "bg-badge-lime",
    accent: "bg-basic-lime-accent",
    border: "border-basic-lime-accent",
    text: "text-basic-lime-subtle",
  },
  red: {
    fill: "bg-badge-red",
    accent: "bg-basic-red-accent",
    border: "border-basic-red-accent",
    text: "text-basic-red-subtle",
  },
  bluedeep: {
    fill: "bg-badge-bluedeep",
    accent: "bg-basic-bluedeep-accent",
    border: "border-basic-bluedeep-accent",
    text: "text-basic-bluedeep-subtle",
  },
} as const;

export type RegionColorScheme = keyof typeof COLOR_SCHEMES;
