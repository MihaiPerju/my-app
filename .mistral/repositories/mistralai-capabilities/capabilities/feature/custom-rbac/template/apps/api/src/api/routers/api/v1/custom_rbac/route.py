"""The access surface index: the admin matrix, the user directory, and ``/me``.

Served under ``/api/v1/custom_rbac`` (this file is the package index, so it contributes the ``access``
segment with no extra path). The reusable routers live in the published
``@mistralai-capabilities/feature-custom-rbac`` package; this module mounts them. The host has already bound the
policy, store and catalog via ``install_access`` in ``create_app``.
"""

from fastapi import APIRouter
from mistralai_capabilities.custom_rbac.api.directory import router as directory_router
from mistralai_capabilities.custom_rbac.api.matrix import router as admin_router
from mistralai_capabilities.custom_rbac.api.me import router as me_router

router = APIRouter()
router.include_router(admin_router)
router.include_router(directory_router)
router.include_router(me_router)
