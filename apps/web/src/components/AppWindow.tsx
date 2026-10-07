import { useEffect, useState } from "react";

const PROMPT = "Build an app that triages support tickets and drafts replies.";
const STEPS = ["Reading your prompt", "Designing workflow", "Generating UI", "Deploying to cloud"];

export function AppWindow() {
  const [typed, setTyped] = useState(0);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typed < PROMPT.length) {
      const id = setTimeout(() => setTyped(typed + 1), 28);
      return () => clearTimeout(id);
    }
    if (step < STEPS.length) {
      const id = setTimeout(() => setStep(step + 1), 700);
      return () => clearTimeout(id);
    }
  }, [typed, step]);

  return (
    <div className="card mx-auto w-full max-w-4xl text-left shadow-[0_40px_120px_-20px_rgb(250_80_15/0.35)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-4 text-xs text-white/40">Mistral Apps — New app</span>
      </div>
      <div className="grid gap-px bg-white/10 md:grid-cols-[1.1fr_1fr]">
        <div className="bg-ink/80 p-6 sm:p-8">
          <p className="text-xs uppercase tracking-widest text-white/40">Prompt</p>
          <p className="mt-3 min-h-20 text-xl leading-snug text-white sm:text-2xl">
            {PROMPT.slice(0, typed)}
            <span className="ml-0.5 inline-block h-6 w-0.5 translate-y-1 animate-[caret_1s_steps(1)_infinite] bg-flame" />
          </p>
          <ul className="mt-6 space-y-3">
            {STEPS.map((label, index) => (
              <li
                key={label}
                className={`flex items-center gap-3 text-sm transition-colors duration-500 ${
                  index < step ? "text-white" : "text-white/25"
                }`}
              >
                <span
                  className={`grid size-5 place-items-center rounded-full text-[10px] transition-all duration-500 ${
                    index < step ? "bg-flame text-white" : "border border-white/20"
                  }`}
                >
                  {index < step ? "✓" : ""}
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-ink/60 p-6 sm:p-8">
          <p className="text-xs uppercase tracking-widest text-white/40">Live preview</p>
          <div
            className={`mt-3 space-y-3 transition-all duration-700 ${
              step >= 3 ? "translate-y-0 opacity-100" : "translate-y-3 opacity-20"
            }`}
          >
            {[
              ["Refund not received", "Urgent", "bg-flame"],
              ["How do I reset my API key?", "Normal", "bg-amber"],
              ["Feature request: dark mode", "Low", "bg-white/40"],
            ].map(([title, tag, color]) => (
              <div
                key={title}
                className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
              >
                <span className="text-sm">{title}</span>
                <span className="flex items-center gap-2 text-xs text-white/60">
                  <span className={`size-2 rounded-full ${color}`} />
                  {tag}
                </span>
              </div>
            ))}
            <div className="rounded-2xl border border-flame/40 bg-flame/10 px-4 py-3 text-sm text-white/80">
              Draft reply ready — “Hi Sam, we’ve issued your refund…”
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
