from env._base import BaseEnv


class Env(BaseEnv):
    # `pg` reads per-user grants from the RBAC store; `allow_all` is dev god-mode.
    custom_rbac_policy: str = "pg"
    # Comma-separated emails seeded as admins on init and protected from demotion/deletion.
    custom_rbac_bootstrap_admins: str = ""
    # Comma-separated page ids the admin matrix can grant `page` access to. Lets a pages-only app
    # make the default catalog usable with no code; an app with data dimensions installs a richer
    # CatalogProvider via `install_access` instead.
    custom_rbac_pages: str = ""

    @property
    def bootstrap_admins(self) -> tuple[str, ...]:
        return tuple(e.strip() for e in self.custom_rbac_bootstrap_admins.split(",") if e.strip())

    @property
    def pages(self) -> tuple[str, ...]:
        return tuple(p.strip() for p in self.custom_rbac_pages.split(",") if p.strip())


env = Env()
