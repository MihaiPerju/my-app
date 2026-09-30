"""The chat-session surface a route module is built from.

``router`` turns one control-plane agent into its session routes; ``schemas`` are the models
those routes answer with; ``sessions`` and ``identity`` are the dependencies they run on.
Nothing here serves — mounting is a caller's decision, made by a module under ``routers/``.
"""
