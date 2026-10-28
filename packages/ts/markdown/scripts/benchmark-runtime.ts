import {
  collectHermesBenchmarkResults,
  collectHermesTransformBenchmarkResults,
} from "./benchmark-core-hermes.js";

declare const print: ((value: string) => void) | undefined;

type HermesBenchmarkPayload = {
  readonly results: ReturnType<typeof collectHermesBenchmarkResults>;
  readonly transformResults: ReturnType<
    typeof collectHermesTransformBenchmarkResults
  >;
};

function writeOutput(value: string): void {
  if (typeof print === "function") {
    print(value);

    return;
  }

  console.log(value);
}

const payload: HermesBenchmarkPayload = {
  results: collectHermesBenchmarkResults(),
  transformResults: collectHermesTransformBenchmarkResults(),
};

writeOutput(JSON.stringify(payload));
