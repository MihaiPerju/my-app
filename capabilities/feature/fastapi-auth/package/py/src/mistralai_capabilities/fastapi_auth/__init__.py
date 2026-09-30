"""The FastAPI \u00d7 auth integration: the gateway-identity gate and the Postgres user store.

``identity`` is the gateway-asserted identity gate and its Protocol seams (the ``UserStore`` and the
structural ``User``); ``stores`` is the one place that names ``db``, binding the Postgres user store
onto that seam. The host installs it with ``install_user_store`` at app construction. Nothing here
serves; the authenticated ``/api/v1`` mount is a template concern.
"""
