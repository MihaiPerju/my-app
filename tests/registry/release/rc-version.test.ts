/**
 * Behavioural tests for the release-candidate version renderer.
 *
 * Two hazards justify this file. First, ONE string has to be legal in two
 * version grammars that disagree about how a pre-release is spelled, and a
 * version that is a millimetre outside either grammar fails at upload time --
 * after the build, on a private index, for one unlucky commit. So the string is
 * checked against the published grammars themselves, not against a hand-written
 * example. Second, the base has to be the next patch after the LAST release,
 * which a lexical tag sort gets wrong the day `v0.10.0` exists.
 */
import { describe, expect, test } from "bun:test";

import {
  latestReleaseTag,
  nextPatch,
  pythonIndexVersion,
  rcVersion,
  renderRcVersion,
  shortSha,
} from "../../../scripts/release/rc/version";

/** The official SemVer 2.0.0 grammar, verbatim from semver.org. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * PEP 440's `VERSION_PATTERN`, verbatim from the specification's appendix (the
 * verbose whitespace and named groups collapsed). This is the PERMISSIVE
 * grammar an installer parses, which is the one that matters: it accepts the
 * `-` before a pre-release segment that makes one string serve both ecosystems.
 */
const PEP440 =
  /^v?(?:(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?dev[-_.]?(\d+)?)?)(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

/** The PEP 440 NORMALISED grammar, also from the appendix: what an index lists. */
const PEP440_NORMALIZED =
  /^([1-9][0-9]*!)?(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*))*((a|b|rc)(0|[1-9][0-9]*))?(\.post(0|[1-9][0-9]*))?(\.dev(0|[1-9][0-9]*))?(\+[a-z0-9]+([-_.][a-z0-9]+)*)?$/;

describe("rc version rendering", () => {
  test("one string is legal in both grammars", () => {
    const { version } = rcVersion("v0.1.2", "31e2ce5db537ca6bbaaee93f5b0b14178cea64a8");
    expect(version).toBe("0.1.3-rc52309221");
    expect(version).toMatch(SEMVER);
    expect(version).toMatch(PEP440);
  });

  /**
   * `mistral apps capability update [<id>] [<version>]` takes ONE positional and
   * decides which it is by shape: a version is anything matching this, and
   * everything else is read as a capability id. A candidate that fell on the
   * wrong side would not error -- it would look up a capability by that name,
   * fail to find it, and the reviewer would never get the bump. Verified against
   * `mistral` v0.3.0.
   */
  const CLI_VERSION_ARG = /^\d|^v\d|^\^|^latest$/;

  test("the CLI reads a candidate as a version, not as a capability id", () => {
    for (const sha of ["31e2ce5", "0000000", "abcdef0", "fffffff"]) {
      expect(renderRcVersion("0.1.3", sha), sha).toMatch(CLI_VERSION_ARG);
    }
  });

  test("the Python index spelling is the same version, normalised", () => {
    const { version } = rcVersion("v0.1.2", "31e2ce5");
    expect(pythonIndexVersion(version)).toBe("0.1.3rc52309221");
    expect(pythonIndexVersion(version)).toMatch(PEP440_NORMALIZED);
    // A release is already normalised.
    expect(pythonIndexVersion("0.1.3")).toBe("0.1.3");
  });

  // The reason the sha is a DECIMAL and not the hex short sha. PEP 440 allows
  // letters after `rc` nowhere; the local segment (`+31e2ce5`) would take them,
  // but npm semver ignores build metadata when comparing versions, so every
  // commit of a pull request would look like the same version to the registry
  // and the second one would be rejected as a duplicate.
  test("no two commits render the same version, and none carries build metadata", () => {
    const versions = ["31e2ce5", "31e2ce6", "0000000", "ffffffe", "fffffff"].map((sha) =>
      renderRcVersion("0.1.3", sha),
    );
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) expect(version, version).not.toContain("+");
  });

  // Semver reads a bare all-digit identifier as a NUMBER, where a leading zero
  // is invalid -- `0.1.3-rc.0123456` is not a version at all. Gluing the digits
  // to `rc` keeps the identifier alphanumeric, and base ten never renders a
  // leading zero anyway, which is also what PEP 440 demands after `rc`.
  test("a sha of every hex shape stays legal in both grammars", () => {
    for (const sha of ["0000000", "0123456", "9999999", "abcdef0", "0a1b2c3", "ffffffff0"]) {
      const version = renderRcVersion("1.2.3", sha);
      expect(version, sha).toMatch(SEMVER);
      expect(version, sha).toMatch(PEP440);
      expect(pythonIndexVersion(version), sha).toMatch(PEP440_NORMALIZED);
    }
    // The spelling all of this exists to avoid.
    expect("1.2.3-rc.0123456").not.toMatch(SEMVER);
  });

  // The number is unreadable on purpose, but it is not lossy: the announcement
  // prints the full sha, and anyone holding only a version can get the short sha
  // back with `printf '%07x'`.
  test("the short sha is recoverable from the version", () => {
    for (const sha of ["0000000", "0123456", "31e2ce5", "fffffff"]) {
      const decimal = renderRcVersion("1.2.3", sha).replace("1.2.3-rc", "");
      expect(Number(decimal).toString(16).padStart(7, "0"), sha).toBe(sha);
    }
  });

  test("the version names the next patch and this commit", () => {
    const { base, version } = rcVersion("v2.10.9", "deadbeefcafe");
    expect(base).toBe("2.10.10");
    expect(version).toBe(`2.10.10-rc${0xdeadbee}`);
  });
});

describe("rc base version", () => {
  test("the latest release tag is the numerically highest, not the lexically highest", () => {
    // The bug a lexical sort ships: "v0.9.0" > "v0.10.0" as strings.
    expect(latestReleaseTag(["v0.1.0", "v0.9.0", "v0.10.0", "v0.2.0"])).toBe("v0.10.0");
    expect(latestReleaseTag(["v1.0.0", "v0.99.99"])).toBe("v1.0.0");
  });

  test("only plain release tags count", () => {
    // A candidate must never be based on another candidate, and the repo carries
    // tags that are not releases.
    expect(latestReleaseTag(["v0.1.2", "v0.1.3-rc52309221", "nightly", "v0.1.3rc52309221"])).toBe(
      "v0.1.2",
    );
    expect(latestReleaseTag(["nightly", "latest"])).toBeUndefined();
  });

  test("the base is the next patch, so a candidate is never named for a published release", () => {
    expect(nextPatch("v0.1.2")).toBe("0.1.3");
    expect(nextPatch("v1.9.0")).toBe("1.9.1");
    // Nothing released yet: the first candidates target the first patch.
    expect(nextPatch(undefined)).toBe("0.0.1");
  });
});

describe("rc sha handling", () => {
  test("a full sha is shortened to seven, a short one is left alone", () => {
    expect(shortSha("31e2ce5db537ca6bbaaee93f5b0b14178cea64a8")).toBe("31e2ce5");
    expect(shortSha("31e2ce5")).toBe("31e2ce5");
  });

  // The sha arrives from a workflow event payload and ends up in an artifact
  // name that is uploaded to a shared index. Anything that is not a sha is a
  // failure, not something to sanitise and carry on with.
  test("anything that is not a lowercase hex sha is rejected", () => {
    for (const bad of ["", "31e2ce", "31E2CE5", "31e2ce5 ", "../../etc", "-rc", "31e2ce5;rm"]) {
      expect(() => shortSha(bad), bad).toThrow(/not a commit sha/);
    }
  });
});
