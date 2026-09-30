// A package-alias import of a `make<CapabilityName>` constructor is NOT caught: the
// rule only inspects project-local (`./` or `../`) import sources, so a bare or
// aliased package specifier slips through. This limitation is stated in the install
// docs, and this fixture pins it: if the rule ever starts flagging package aliases,
// this file will begin producing a diagnostic and the harness will fail.
import { makeUserService } from "@app/user-service";

// A project-local import whose name is not a service constructor is also fine.
import { UserService } from "./user-service";

export const service = makeUserService;
export type Service = UserService;
