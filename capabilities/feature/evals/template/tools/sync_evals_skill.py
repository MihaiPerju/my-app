#!/usr/bin/env python
"""Sync the `capability-evals` skill between this app and the AI Registry (AI Studio).

The AI Registry (console `build/skills`) is the source of truth. This script bridges it to the
local skill dir:
  pull     registry -> local dir  (materialize SKILL.md + methodology refs)
  push     local dir -> registry  (create the skill, or a draft new version)
  publish  local dir -> registry  (push and move the `main` alias)
"""

import argparse
import os
import sys
from pathlib import Path

# The registry object name — this is what identifies the merged evals skill everywhere, and it is
# written back as the SKILL.md frontmatter `name:` on pull, so it must match the committed skill dir.
SKILL_NAME = "capability-evals"
# The registry addresses an existing skill by a `skill:<name>` URN or its UUID.
SKILL_URN = f"skill:{SKILL_NAME}"

# The default skill directory, resolved relative to this script:
# capabilities/evals/template/tools/ -> capabilities/evals/template/.agents/skills/capability-evals
DEFAULT_SKILL_DIR = Path(__file__).resolve().parent.parent / ".agents" / "skills" / "capability-evals"

# Capability-owned overlay files: excluded from push, preserved on pull.
OVERLAY_FILES = {"references/app-conventions.md"}

SKILL_ENTRY_FILE = "SKILL.md"


def parse_skill_markdown(text: str) -> tuple[str, str]:
    """Split a SKILL.md into (description, body).

    Frontmatter is a leading `---` fenced block. This reads its `description:` line and returns
    everything after the fence as the body. `name` is dropped: the registry derives the name from
    the object, and a pulled skill name comes from its directory.
    """
    description = ""
    body = text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            frontmatter = text[3:end]
            body = text[end + 4 :].lstrip("\n")
            for line in frontmatter.splitlines():
                stripped = line.strip()
                if stripped.startswith("description:"):
                    description = stripped[len("description:") :].strip()
                    # tolerate a JSON/quoted value
                    if len(description) >= 2 and description[0] in "\"'" and description[-1] == description[0]:
                        description = description[1:-1]
    return description, body


def build_definition(skill_dir: Path) -> dict:
    """Build the registry `definition` from a local skill directory.

    SKILL.md -> description + body; every other file (except the capability
    overlay) -> a text asset keyed by its POSIX-relative path.
    """
    entry = skill_dir / SKILL_ENTRY_FILE
    if not entry.is_file():
        sys.exit(f"error: {entry} not found")
    description, body = parse_skill_markdown(entry.read_text(encoding="utf-8"))
    if not description:
        sys.exit(f"error: {entry} has no `description:` in its frontmatter")

    assets: dict[str, dict] = {}
    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file() or path.name == SKILL_ENTRY_FILE:
            continue
        rel = path.relative_to(skill_dir).as_posix()
        if rel in OVERLAY_FILES:
            continue  # capability-owned; never leaves the repo
        assets[rel] = {
            "text_content": path.read_text(encoding="utf-8"),
            "is_executable": False,
        }
    return {"description": description, "body": body, "assets": assets}


def make_client(server_url: str | None):
    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        sys.exit("error: MISTRAL_API_KEY is not set")
    Mistral = None
    for import_path in ("mistralai", "mistralai.client"):
        try:
            module = __import__(import_path, fromlist=["Mistral"])
            Mistral = module.Mistral
            break
        except (ImportError, AttributeError):
            continue
    if Mistral is None:
        sys.exit(
            "error: the Mistral SDK is not installed. Install it, e.g.:\n"
            "  pip install mistralai\n"
            "  # or: uv run --with mistralai python sync_evals_skill.py ..."
        )
    kwargs = {"api_key": api_key}
    server_url = server_url or os.environ.get("MISTRAL_BASE_URL")
    if server_url:
        kwargs["server_url"] = server_url
    return Mistral(**kwargs)


def _get_existing(client):
    """Return the existing skill record, or None if it genuinely does not exist.

    Only a definitive 404 means treat as new. Transport, auth, and 5xx errors must abort. Swallowing
    them would make a transient failure look like no skill, and push would then create a duplicate of
    an existing skill.
    """
    try:
        return client.beta.skills.get(skill_id=SKILL_URN)
    except Exception as exc:
        if getattr(exc, "status_code", None) == 404:
            return None
        raise


def cmd_push(args) -> None:
    skill_dir = Path(args.skill_dir)
    definition = build_definition(skill_dir)
    client = make_client(args.server_url)
    aliases = ["main"] if args.publish else None

    existing = _get_existing(client)
    if existing is not None:
        version = client.beta.skills.create_version(
            skill_id=existing.id,
            definition=definition,
            notes=args.notes,
            aliases=aliases,
        )
        print(  # noqa: T201 — intentional CLI feedback
            f"updated skill {existing.id} -> v{version.version} "
            f"({len(definition['assets'])} assets)" + (" [main moved]" if args.publish else " [draft, main not moved]")
        )
        return

    # First creation. sharing_scope may not be accepted by every SDK build, so
    # retry without it and set it in a follow-up call if needed.
    create_kwargs = dict(
        name=SKILL_NAME,
        definition=definition,
        notes=args.notes,
        aliases=aliases,
    )
    try:
        skill = client.beta.skills.create(sharing_scope=args.sharing_scope, **create_kwargs)
    except TypeError:
        skill = client.beta.skills.create(**create_kwargs)
        _try_set_sharing_scope(client, skill.id, args.sharing_scope)
    print(  # noqa: T201 — intentional CLI feedback
        f"created skill {skill.id} (v{skill.version}, sharing={args.sharing_scope}, "
        f"{len(definition['assets'])} assets)" + (" [published to main]" if args.publish else " [draft, no main alias]")
    )


def _try_set_sharing_scope(client, skill_id: str, sharing_scope: str) -> None:
    for attempt in (
        lambda: client.beta.skills.update_sharing_scope(skill_id=skill_id, sharing_scope=sharing_scope),
        lambda: client.beta.skills.update_metadata(skill_id=skill_id, sharing_scope=sharing_scope),
    ):
        try:
            attempt()
            return
        except Exception:
            continue
    print(  # noqa: T201 — intentional CLI feedback
        f"warning: could not set sharing scope to {sharing_scope!r}; set it in the console.",
        file=sys.stderr,
    )


def cmd_pull(args) -> None:
    skill_dir = Path(args.skill_dir)
    client = make_client(args.server_url)
    skill = (
        client.beta.skills.get(skill_id=SKILL_URN, alias=args.alias)
        if args.alias
        else client.beta.skills.get(skill_id=SKILL_URN)
    )
    definition = skill.definition
    skill_dir.mkdir(parents=True, exist_ok=True)

    # Rebuild SKILL.md with a `name:` (from the directory) + the registry description.
    description = getattr(definition, "description", "") or ""
    body = getattr(definition, "body", "") or ""
    entry_text = f"---\nname: {SKILL_NAME}\ndescription: {description}\n---\n\n{body}"
    if not entry_text.endswith("\n"):
        entry_text += "\n"
    (skill_dir / SKILL_ENTRY_FILE).write_text(entry_text, encoding="utf-8")
    written = [SKILL_ENTRY_FILE]

    assets = getattr(definition, "assets", None) or {}
    for rel, asset in assets.items():
        if rel in OVERLAY_FILES:
            continue  # never let the registry clobber the capability overlay
        # Reject path traversal: resolve the target and ensure it stays under skill_dir.
        target = (skill_dir / rel).resolve()
        if not target.is_relative_to(skill_dir.resolve()):
            print(f"warning: asset {rel} escapes skill directory; skipped", file=sys.stderr)  # noqa: T201 — intentional CLI feedback
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        text = getattr(asset, "text_content", None)
        if text is None and isinstance(asset, dict):
            text = asset.get("text_content")
        if text is None:
            print(f"warning: asset {rel} is not text; skipped", file=sys.stderr)  # noqa: T201 — intentional CLI feedback
            # Still track as written so we don't prune a local file we couldn't refresh.
            written.append(rel)
            continue
        target.write_text(text, encoding="utf-8")
        written.append(rel)

    # Prune files a previous pull wrote that the registry has since dropped, so
    # stale references don't accumulate (and get vendored into generated apps).
    # The capability overlay is never pruned.
    wanted = set(written) | OVERLAY_FILES
    removed = 0
    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(skill_dir).as_posix()
        if rel not in wanted:
            path.unlink()
            removed += 1
            print(f"removed stale {rel}")  # noqa: T201 — intentional CLI feedback

    print(f"pulled {SKILL_NAME} (v{skill.version}); wrote {len(written)} files, removed {removed}")  # noqa: T201 — intentional CLI feedback
    print(f"preserved overlay: {', '.join(sorted(OVERLAY_FILES))}")  # noqa: T201 — intentional CLI feedback


def _add_push_args(parser) -> None:
    parser.add_argument("--notes", default="sync from app repo", help="Version notes.")
    parser.add_argument(
        "--sharing-scope",
        default="workspace",
        choices=["private", "workspace"],
        help="Sharing scope on first creation.",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--skill-dir",
        default=str(DEFAULT_SKILL_DIR),
        help="Local skill directory (default: this capability's skill).",
    )
    parser.add_argument(
        "--server-url",
        default=None,
        help="Mistral API base URL (default: env MISTRAL_BASE_URL or the SDK default).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_pull = sub.add_parser("pull", help="Refresh the local methodology from the registry (overlay preserved).")
    p_pull.add_argument("--alias", default="main", help="Alias to pull (default: main). Pass empty to pull the latest.")
    p_pull.set_defaults(func=cmd_pull)

    p_push = sub.add_parser("push", help="Create the skill or a new DRAFT version in the registry (main not moved).")
    _add_push_args(p_push)
    p_push.set_defaults(func=cmd_push, publish=False)

    p_publish = sub.add_parser("publish", help="Push AND move the `main` alias (surfaces the skill in vibe/Le Chat).")
    _add_push_args(p_publish)
    p_publish.set_defaults(func=cmd_push, publish=True)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
