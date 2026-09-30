declare const flag: boolean;
declare const base: { a: number };

const bothArmsPopulated = { ...(flag ? { a: 1 } : { b: 2 }) };

const plainSpread = { ...base };

const conditionalArraySpread = [...(flag ? [1] : [])];
