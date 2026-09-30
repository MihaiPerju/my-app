// The `core` vertical's UI surface: the product-page shell, the form controls, the empty, error
// and loading states, and the JSON inspector. Design-system primitives (`DropdownMenu*`,
// `AutosizeTextarea`, `Resizable*`, ...) are not re-exported here: import them from their
// `@mistralai/ui/<name>` subpath.
//
// This is a barrel, not one subpath per component, because the manifest sets `"sideEffects": false`
// so rollup drops whatever an importer does not name.

export * from "./form-controls";
export * from "./json-inspector";
export * from "./product-page";
export * from "./states";
