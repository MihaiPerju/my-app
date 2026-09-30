"""The workflow-execution surface a route module is built from.

``router`` turns one workflow class into its execution routes; ``schemas`` are the app-owned models
those routes answer with; ``commands`` and ``ownership`` are the dependencies they run on. Nothing
here serves; mounting is a caller's decision, made by a module under ``routers/``.
"""
