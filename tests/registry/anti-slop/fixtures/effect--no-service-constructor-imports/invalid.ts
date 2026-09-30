// Importing a project-local `make<CapabilityName>` service constructor into runtime
// code (a non-test file) is the exact pattern this rule targets: the constructor's
// dependencies must propagate through the Layer, not be pulled in directly.
import { makeUserService } from "./user-service";

export const service = makeUserService;
