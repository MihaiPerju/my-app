"""Tiny read-only npm registry used to exercise package acquisition in the E2E.

It deliberately implements only the two reads `bun add` needs: package metadata and tarballs.
The artifacts themselves still come from the real prepare-publish + pack-all pipeline.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import tarfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def rewrite_descriptor_source(
    tarball: Path, registry_url: str, git_source: str
) -> None:
    """Use local npm artifacts and this committed registry's template-only sources."""
    replacement = tarball.with_suffix(".rewritten.tgz")
    with (
        tarfile.open(tarball, "r:gz") as source,
        tarfile.open(replacement, "w:gz") as target,
    ):
        found = False
        for member in source.getmembers():
            if not member.isfile():
                target.addfile(member)
                continue
            extracted = source.extractfile(member)
            if extracted is None:
                raise RuntimeError(f"could not read {member.name} from {tarball}")
            payload = extracted.read()
            if member.name == "package/registry.json":
                descriptor = json.loads(payload)
                descriptor["sources"]["ts"] = registry_url
                descriptor["sources"]["git"] = git_source
                payload = (json.dumps(descriptor, indent=2) + "\n").encode()
                member.size = len(payload)
                found = True
            target.addfile(member, io.BytesIO(payload))
    if not found:
        replacement.unlink(missing_ok=True)
        raise RuntimeError(f"{tarball} contains no package/registry.json")
    os.replace(replacement, tarball)


class LocalNpmRegistry:
    """Context-managed loopback server backed by already-packed npm tarballs."""

    def __init__(self) -> None:
        self._packages: dict[str, dict[str, Any]] = {}
        registry = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                registry._get(self)

            def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                registry._get(self, head_only=True)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}/"

    def __enter__(self) -> LocalNpmRegistry:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def add(self, tarball: Path) -> None:
        with tarfile.open(tarball, "r:gz") as archive:
            manifest_file = archive.extractfile("package/package.json")
            if manifest_file is None:
                raise RuntimeError(f"{tarball} contains no package/package.json")
            manifest = json.loads(manifest_file.read())
        name = manifest.get("name")
        version = manifest.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise RuntimeError(f"{tarball} has no string package name/version")
        payload = tarball.read_bytes()
        tar_path = f"/tarballs/{len(self._packages)}.tgz"
        manifest["dist"] = {
            "tarball": f"{self.url.rstrip('/')}{tar_path}",
            # npm's packument schema requires this legacy transport checksum. It is not used for
            # a security decision (the SHA-512 SRI below is the integrity check).
            "shasum": hashlib.sha1(payload, usedforsecurity=False).hexdigest(),
            "integrity": "sha512-"
            + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii"),
        }
        self._packages[name] = {
            "metadata": {
                "name": name,
                "dist-tags": {"latest": version},
                "versions": {version: manifest},
            },
            "payload": payload,
            "tar_path": tar_path,
        }

    def _get(self, request: BaseHTTPRequestHandler, head_only: bool = False) -> None:
        path = urllib.parse.unquote(request.path.partition("?")[0]).rstrip("/")
        name = path.removeprefix("/")
        package = self._packages.get(name)
        if package is not None:
            payload = json.dumps(package["metadata"]).encode()
            self._respond(request, 200, "application/json", payload, head_only)
            return
        for candidate in self._packages.values():
            if path == candidate["tar_path"]:
                self._respond(
                    request,
                    200,
                    "application/octet-stream",
                    candidate["payload"],
                    head_only,
                )
                return
        self._respond(
            request, 404, "application/json", b'{"error":"not found"}', head_only
        )

    @staticmethod
    def _respond(
        request: BaseHTTPRequestHandler,
        status: int,
        content_type: str,
        payload: bytes,
        head_only: bool,
    ) -> None:
        request.send_response(status)
        request.send_header("Content-Type", content_type)
        request.send_header("Content-Length", str(len(payload)))
        request.end_headers()
        if not head_only:
            request.wfile.write(payload)
