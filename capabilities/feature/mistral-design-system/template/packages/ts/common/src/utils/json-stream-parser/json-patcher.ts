import type { Patch } from "../patch";
import type { JSONParseToken } from "./json-stream-parser";
import { JSONStreamTokenizer } from "./json-stream-parser";

/**
 * Converts JSON tokens directly into JSON patches.
 */

type ParserScope =
  | { type: "global"; path: string }
  | { type: "array"; path: string; lastIndex: number }
  | { type: "object"; path: string; key: string };

const getScopePath = (scope: ParserScope): string | null | number => {
  return scope.type === "array"
    ? `${scope.lastIndex}`
    : scope.type === "object"
      ? scope.key
      : null;
};

/**
 * JSON-Patcher turns a stream of JSON text chunks into a stream of JSON patch objects.
 *
 * Note: string values get streamed progressively as Append operations before the string is fully generated.
 * This is a useful behavior because it enables us to display long assistant messages or tool call arguments
 * progressively in the UI.
 *
 * The downside is that the presence of a key in your object doesn't guarantee that the key is fully generated.
 */
export class JSONPatcher {
  private tokenizer = new JSONStreamTokenizer();
  private stack: ParserScope[] = [];
  private currentScope: ParserScope = { type: "global", path: "" };
  private lastEmittedValue = new Map<string, unknown>();
  private allowedPartialPaths: Set<string> | "*";
  constructor({
    allowedPartialPaths = "*",
  }: { allowedPartialPaths?: string[] | "*" } = {}) {
    this.allowedPartialPaths =
      allowedPartialPaths === "*" ? "*" : new Set(allowedPartialPaths);
  }

  /**
   * Returns the number of tracked paths in the internal cache.
   * Should be 0 after parsing completes. Useful for testing memory leaks.
   */
  getPendingPathCount(): number {
    return this.lastEmittedValue.size;
  }

  write(jsonStr: string): Patch[] {
    const events = this.tokenizer.write(jsonStr);
    return this.processEvents(events);
  }

  end(): Patch[] {
    const events = this.tokenizer.end();
    return this.processEvents(events);
  }

  getCurrentPath(): string {
    const scopePath = getScopePath(this.currentScope);
    const parentPath = this.currentScope.path;
    return this.currentScope.type === "global"
      ? "/"
      : (parentPath === "/" ? "" : parentPath) + "/" + scopePath;
  }

  private isPartialPath(path: string): boolean {
    return (
      this.allowedPartialPaths === "*" || this.allowedPartialPaths.has(path)
    );
  }

  private processEvents(events: JSONParseToken[]): Patch[] {
    const operations: Patch[] = [];

    for (const event of events) {
      switch (event.type) {
        case "startObject": {
          const newObj = {};
          if (this.currentScope.type === "array") {
            this.currentScope.lastIndex++;
          }

          operations.push({
            op: this.stack.length > 0 ? "add" : "replace",
            path: this.getCurrentPath(),
            value: newObj,
          });

          const path = this.getCurrentPath();
          this.stack.push(this.currentScope);
          this.currentScope = {
            type: "object",
            path,
            key: "",
          };
          break;
        }
        case "startArray": {
          if (this.currentScope.type === "array") {
            this.currentScope.lastIndex++;
          }

          operations.push({
            op: this.stack.length > 0 ? "add" : "replace",
            path: this.getCurrentPath(),
            value: [],
          });

          const path = this.getCurrentPath();
          this.stack.push(this.currentScope);
          this.currentScope = {
            type: "array",
            path,
            lastIndex: -1,
          };
          break;
        }
        case "endObject":
        case "endArray": {
          this.currentScope = this.stack.pop() || this.currentScope;
          break;
        }
        case "key": {
          if (this.currentScope.type === "object") {
            this.currentScope.key = event.value;
          }
          break;
        }
        case "value_start": {
          if (this.currentScope.type === "array") {
            this.currentScope.lastIndex++;
          }
          const path = this.getCurrentPath();
          // Only emit paths that are marked as allowed to be partial
          if (!this.isPartialPath(path)) {
            break;
          }
          operations.push({
            op: this.stack.length > 0 ? "add" : "replace",
            path,
            value: event.value,
          });
          this.lastEmittedValue.set(path, event.value);
          break;
        }
        case "value_update": {
          const path = this.getCurrentPath();
          const lastValue = this.lastEmittedValue.get(path);
          // Only emit paths that are marked as allowed to be partial
          if (!this.isPartialPath(path)) {
            break;
          }

          if (lastValue !== event.value) {
            // For strings: emit append with delta (never replace to avoid re-streaming content)
            if (
              typeof lastValue === "string" &&
              typeof event.value === "string"
            ) {
              const delta = event.value.slice(lastValue.length);
              if (delta) {
                operations.push({ op: "append", path, value: delta });
              }
            } else {
              // For non-strings: keep replace behavior
              operations.push({ op: "replace", path, value: event.value });
            }
            this.lastEmittedValue.set(path, event.value);
          }
          break;
        }
        case "value_complete": {
          const path = this.getCurrentPath();
          const lastValue = this.lastEmittedValue.get(path);
          if (lastValue === undefined) {
            operations.push({
              op: this.stack.length > 0 ? "add" : "replace",
              path,
              value: event.value,
            });
          } else if (lastValue !== event.value) {
            // For strings: emit append with delta (never replace to avoid re-streaming content)
            if (
              typeof lastValue === "string" &&
              typeof event.value === "string"
            ) {
              const delta = event.value.slice(lastValue.length);
              if (delta) {
                operations.push({ op: "append", path, value: delta });
              }
            } else {
              operations.push({ op: "replace", path, value: event.value });
            }
          }
          this.lastEmittedValue.delete(path);
          if (this.currentScope.type === "object") {
            this.currentScope.key = "";
          }
          break;
        }
      }
    }
    return operations;
  }
}
