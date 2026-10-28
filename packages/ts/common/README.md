# `@mistral/common`

This package contains common and agnostic TypeScript utilities and types to be used across other applications and packages.

## Overview

The package is organized into two main categories:

- **Types** (`src/types/`): TypeScript type definitions and utilities for compile-time type checking
- **Utils** (`src/utils/`): Runtime utility functions for common operations

## Testing

Ideally, each new utility or type addition should be tested.

### Runtime Utilities

Runtime utilities (in `src/utils/`) should have corresponding test files named `*.test.ts`.

### Type Utilities

Type utilities (in `src/types/`) should have type-level test files named `*.test-d.ts`. Type tests are validated at compile time and will fail the type checker if the types don't match expectations.
