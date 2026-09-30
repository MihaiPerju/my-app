"""Write the FastAPI app's OpenAPI schema to PATH (default: apps/api/openapi.json)."""

import json
import sys
from pathlib import Path


def main() -> None:
    # Importing `api.main` builds the app once; use that instance rather than building a second.
    from api.main import app

    path = Path(sys.argv[1] if len(sys.argv) > 1 else "apps/api/openapi.json")
    path.write_text(json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {path}")  # noqa: T201


if __name__ == "__main__":
    main()
