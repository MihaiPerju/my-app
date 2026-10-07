import { Reveal } from "./Reveal";
import { AppWindow } from "./AppWindow";

const NAV = ["Overview", "Features", "Models", "Pricing"];

const FEATURES = [
  {
    eyebrow: "Describe",
    title: "Say it. It exists.",
    body: "Turn a sentence into a working app with data, logic and interface. No boilerplate, no setup, no waiting.",
    span: "md:col-span-2",
  },
  {
    eyebrow: "Connect",
    title: "Your data, already inside.",
    body: "Plug into Slack, Notion, Drive and your databases with a single click.",
    span: "",
  },
  {
    eyebrow: "Automate",
    title: "Workflows that run themselves.",
    body: "Durable, observable agents that schedule, retry and report back.",
    span: "",
  },
  {
    eyebrow: "Deploy",
    title: "From prototype to production in one push.",
    body: "Every app ships with auth, logging and scaling built in — on Mistral Cloud or your own infrastructure.",
    span: "md:col-span-2",
  },
];

const STATS = [
  ["10×", "faster than hand-coding"],
  ["60s", "from prompt to preview"],
  ["100%", "yours to own and export"],
];

export function Landing({ appName }: { appName: string }) {
  return (
    <div className="overflow-x-clip">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-ink/70 backdrop-blur-xl backdrop-saturate-150">
        <nav className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6 text-xs text-white/70">
          <a href="#top" className="font-semibold text-white">
            {appName}
          </a>
          <ul className="hidden gap-8 sm:flex">
            {NAV.map((item) => (
              <li key={item}>
                <a
                  href={`#${item.toLowerCase()}`}
                  className="transition-colors hover:text-white"
                >
                  {item}
                </a>
              </li>
            ))}
          </ul>
          <a
            href="#get-started"
            className="rounded-full bg-white px-3 py-1 font-medium text-black transition hover:bg-white/80"
          >
            Get started
          </a>
        </nav>
      </header>

      <main id="top">
        <section
          id="overview"
          className="relative flex min-h-screen flex-col items-center px-6 pb-24 pt-36 text-center"
        >
          <div className="glow pointer-events-none absolute left-1/2 top-24 -z-10 h-130 w-130 -translate-x-1/2 animate-[drift_9s_ease-in-out_infinite_alternate]" />
          <Reveal as="p" className="text-lg font-medium text-flame">
            Introducing
          </Reveal>
          <Reveal as="h1" delay={100} className="headline mt-2 text-6xl sm:text-8xl">
            Mistral <span className="gradient-text">Apps</span>.
          </Reveal>
          <Reveal
            as="p"
            delay={200}
            className="mt-6 max-w-2xl text-xl text-white/60 sm:text-2xl"
          >
            Describe what you need. Get a real, deployed application. Intelligence, built into
            every layer.
          </Reveal>
          <Reveal delay={300} className="mt-9 flex items-center gap-6">
            <a
              href="#get-started"
              className="rounded-full bg-flame px-6 py-3 text-base font-medium text-white transition hover:brightness-110"
            >
              Start building
            </a>
            <a href="#features" className="text-base text-amber hover:underline">
              Watch the film ›
            </a>
          </Reveal>
          <Reveal delay={450} className="mt-20 w-full">
            <AppWindow />
          </Reveal>
        </section>

        <section className="mx-auto max-w-5xl px-6 py-40 text-center">
          <Reveal as="h2" className="headline text-4xl sm:text-7xl">
            Software used to take months.
            <br />
            <span className="text-white/35">Now it takes a thought.</span>
          </Reveal>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-6 pb-32">
          <Reveal as="h2" className="headline mb-14 text-4xl sm:text-6xl">
            Everything an app needs.
            <span className="text-white/35"> Nothing it doesn’t.</span>
          </Reveal>
          <div className="grid gap-5 md:grid-cols-3">
            {FEATURES.map((feature, index) => (
              <Reveal
                key={feature.title}
                delay={(index % 2) * 120}
                className={`card flex min-h-80 flex-col justify-end p-8 sm:p-10 ${feature.span}`}
              >
                <p className="text-sm font-medium uppercase tracking-widest text-flame">
                  {feature.eyebrow}
                </p>
                <h3 className="headline mt-3 text-3xl sm:text-4xl">{feature.title}</h3>
                <p className="mt-4 max-w-md text-lg text-white/55">{feature.body}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section id="models" className="relative px-6 py-32 text-center">
          <div className="glow pointer-events-none absolute inset-x-0 top-1/2 -z-10 mx-auto h-100 w-200 max-w-full -translate-y-1/2 opacity-60" />
          <Reveal as="p" className="text-lg font-medium text-flame">
            Powered by Mistral models
          </Reveal>
          <Reveal as="h2" delay={100} className="headline mx-auto mt-3 max-w-4xl text-4xl sm:text-7xl">
            Frontier intelligence. <span className="gradient-text">Open at heart.</span>
          </Reveal>
          <div className="mx-auto mt-20 grid max-w-4xl gap-10 sm:grid-cols-3">
            {STATS.map(([value, label], index) => (
              <Reveal key={label} delay={index * 120}>
                <p className="headline gradient-text text-7xl">{value}</p>
                <p className="mt-2 text-white/55">{label}</p>
              </Reveal>
            ))}
          </div>
        </section>

        <section id="get-started" className="px-6 py-40 text-center">
          <Reveal as="h2" className="headline text-5xl sm:text-8xl">
            Your next app
            <br />
            starts with a sentence.
          </Reveal>
          <Reveal delay={150} className="mt-10 flex flex-wrap justify-center gap-4">
            <a
              href="#top"
              className="rounded-full bg-flame px-8 py-4 text-lg font-medium text-white transition hover:brightness-110"
            >
              Try {appName} free
            </a>
            <a
              href="#features"
              className="rounded-full border border-white/20 px-8 py-4 text-lg font-medium transition hover:bg-white/10"
            >
              Talk to sales
            </a>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-white/10 px-6 py-10 text-center text-xs text-white/40">
        © 2026 {appName}. A demo landing page, inspired by the best of product design.
      </footer>
    </div>
  );
}
