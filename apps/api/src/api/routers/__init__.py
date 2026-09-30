"""Every router this app serves. The directory tree is the URL tree.

Each module serves (``router``) or declares (``segment``, ``dependencies``). A module lives in one
group, which is the access declaration: ``internal`` is unversioned and anonymous; ``v1`` is the
authenticated surface whose ``dependencies`` cascade to everything beneath it. A new group must
declare ``dependencies``, or the import fails, so a group cannot default to public.
"""
