"""The speech feature's API surface. The directory is the ``/speech`` segment.

Everything the feature serves hangs off this one package, one module per segment:
``transcribe.py`` and ``synthesize.py`` are ``WorkflowRouter`` mounts, ``realtime.py`` mints a
browser realtime session with a stateless POST. That difference is the delivery mechanism, not
the caller's concern, so all three sit at the same level. This package declares no rule and
inherits ``v1``'s ``require_user``, which fails discovery closed if the cascade is ever removed.

Do not delete this file: ``pkgutil.iter_modules`` skips namespace packages, so without
``__init__.py`` the loader never descends and every route below vanishes.
"""
