from fastapi import FastAPI
from mistralai_capabilities.workflows.encryption import payload_encryption


async def startup(_app: FastAPI) -> None:
    payload_encryption()
