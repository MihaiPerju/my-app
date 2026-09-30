"""The ``/api/v1/custom_rbac`` surface: the RBAC admin matrix, the user directory, and ``/me``.

This package declares no access rule of its own: ``v1`` declares ``(Depends(require_user),)`` and
the loader cascades it, so every route here has a resolved caller; the admin routes add
``require_admin`` on top. The routers themselves are the reusable ones from the published
``@mistralai-capabilities/feature-custom-rbac`` package; ``route.py`` mounts them.
"""
