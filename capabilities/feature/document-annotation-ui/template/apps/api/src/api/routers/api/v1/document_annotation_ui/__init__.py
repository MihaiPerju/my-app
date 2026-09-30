"""The Document Annotation UI feature's API surface.

The directory is the ``/document_annotation_ui`` segment.

Everything the feature serves hangs off this one package, one module per segment, whether the
module is a ``WorkflowRouter`` mount (``document.py``) or a hand-rolled router (the other five).
How a route is delivered is not the caller's business and does not appear in its URL — which is
also why ``workflows.py`` can be what it says it is, the list of workflows at
``/document_annotation_ui/workflows``. Access is inherited from ``v1``; this package
declares no rule of its own.

Do not delete this file: ``pkgutil.iter_modules`` skips namespace packages, so without
``__init__.py`` the loader never descends and every route below vanishes.
"""
