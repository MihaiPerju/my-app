type ObjectAlias = object;

function direct(input: object): void {}

function aliased(input: ObjectAlias): void {}

function unioned(input: object | string): void {}

function parenthesized(input: (object)): void {}
