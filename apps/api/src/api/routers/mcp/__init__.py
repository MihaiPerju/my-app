"""The top-level MCP transport, explicitly served without FastAPI dependencies."""

from fastapi import params

dependencies: tuple[params.Depends, ...] = ()
