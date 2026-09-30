/**
 * Mistral-scoped npm packages reviewed as anonymously available from registry.npmjs.org.
 * Scope alone does not prove privacy. Keep this exact-name list small: adding a name permits it
 * in public Core's app template and in the public npm dependency gate. Verify the package and
 * intended version on the anonymous index before adding it here.
 */
export const PUBLIC_MISTRAL_NPM_EXEMPTIONS: ReadonlySet<string> = new Set([
  // Public SDK: https://www.npmjs.com/package/@mistralai/mistralai
  "@mistralai/mistralai",
]);
