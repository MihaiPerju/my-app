// Global type declarations for the monorepo.
// This file is referenced by tsconfig.base.json so all packages pick it up.

// CSS side-effect imports (e.g. `import './styles.css'`)
// CSS modules return a string-keyed record (e.g. `import styles from './x.module.css'`)
declare module "*.css" {
  const classes: Record<string, string>;
  export default classes;
}

// server-only is a Next.js runtime guard with no type declarations.
declare module "server-only" {}

// @swc-node/register is a runtime hook with no type declarations.
declare module "@swc-node/register" {}
