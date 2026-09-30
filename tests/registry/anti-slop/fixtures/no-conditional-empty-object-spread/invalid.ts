declare const flag: boolean;

const emptyAlternate = { ...(flag ? { a: 1 } : {}) };

const emptyConsequent = { ...(flag ? {} : { a: 1 }) };

const parenthesized = { ...((flag ? { a: 1 } : {})) };
