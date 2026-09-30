import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { runCommand } from "../shared/run-command";
import { forbiddenReferenceLabels } from "./public-artifact-policy";

export interface Finding {
  artifact: string;
  member: string;
  part: "content" | "name";
  policy: string;
}

export interface ArchiveMember {
  /** Path within the archive, `/`-separated. */
  name: string;
  /** Hex sha256 of the member's bytes. Absent for a directory or a symlink. */
  digest?: string;
}

export interface ScanResult {
  findings: Finding[];
  /** Every member of the archive, directories and symlinks included. */
  members: ArchiveMember[];
  scanned: number;
}

interface ExtractedMember {
  name: string;
  path?: string;
}

async function extractArchive(artifact: string, destination: string): Promise<void> {
  // Do not pass unzip's overwrite flag: a wheel with duplicate paths must fail instead of silently
  // collapsing two members into one. npm-generated tarballs are trusted build outputs; duplicate
  // tar members are outside this accidental-leak threat model.
  const command = artifact.endsWith(".whl")
    ? ["unzip", "-qq", artifact, "-d", destination]
    : ["tar", "-xzf", artifact, "-C", destination];
  const result = await runCommand(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not extract ${relative(process.cwd(), artifact)}: ${result.stderr || `exit ${result.exitCode}`}`,
    );
  }
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Walk without following symlinks: names are policy inputs, regular files are content inputs. */
function extractedMembers(extractionRoot: string, directory = extractionRoot): ExtractedMember[] {
  const members: ExtractedMember[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = relative(extractionRoot, path).split(sep).join("/");
    members.push({ name, path: entry.isFile() ? path : undefined });
    if (entry.isDirectory()) members.push(...extractedMembers(extractionRoot, path));
  }
  return members;
}

export async function scanArtifact(artifact: string): Promise<ScanResult> {
  const extractionRoot = mkdtempSync(join(tmpdir(), "public-artifact-check-"));
  const artifactLabel = relative(process.cwd(), artifact);
  try {
    await extractArchive(artifact, extractionRoot);
    const findings: Finding[] = [];
    const members: ArchiveMember[] = [];
    let scanned = 0;
    for (const member of extractedMembers(extractionRoot)) {
      for (const policy of forbiddenReferenceLabels(member.name)) {
        findings.push({ artifact: artifactLabel, member: member.name, part: "name", policy });
      }
      if (member.path === undefined) {
        members.push({ name: member.name });
        continue;
      }
      const bytes = readFileSync(member.path);
      members.push({ digest: sha256(bytes), name: member.name });
      // Every policy is ASCII. Latin-1 maps each byte to one code point, so embedded markers remain
      // searchable without dropping files that contain NULs or invalid UTF-8 (fonts, wasm, etc.).
      const content = bytes.toString("latin1");
      scanned++;
      for (const policy of forbiddenReferenceLabels(content)) {
        findings.push({ artifact: artifactLabel, member: member.name, part: "content", policy });
      }
    }
    if (scanned === 0) {
      throw new Error(`${artifactLabel} contains zero regular files`);
    }
    return { findings, members, scanned };
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}
