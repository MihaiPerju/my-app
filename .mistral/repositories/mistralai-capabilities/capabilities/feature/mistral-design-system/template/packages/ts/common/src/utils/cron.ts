export type CronAny = { type: "any" };
export type CronValue = { type: "value"; value: number };
export type CronRange = { type: "range"; from: number; to: number };
export type CronList = { type: "list"; values: (CronValue | CronRange)[] };
export type CronStep = {
  type: "step";
  base: CronAny | CronValue | CronRange;
  step: number;
};

export type CronFieldValue =
  | CronAny
  | CronValue
  | CronRange
  | CronList
  | CronStep;
export type CronUnit = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";
export type CronData = Record<CronUnit, CronFieldValue>;

export type ParseCronResult =
  | { success: true; data: CronData }
  | { success: false };

interface FieldConfig {
  allowed: Set<string>;
  toNumber: (normalized: string) => number | undefined;
}

const DAY_OF_WEEK_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function makeNumericSet(min: number, max: number): Set<string> {
  const set = new Set<string>();
  for (let i = min; i <= max; i++) {
    set.add(String(i));
  }
  return set;
}

function makeSetWithNames(
  min: number,
  max: number,
  names: Record<string, number>,
): Set<string> {
  const set = makeNumericSet(min, max);
  for (const name of Object.keys(names)) {
    set.add(name);
  }
  return set;
}

function stringToNumber(normalized: string): number | undefined {
  const n = Number(normalized);
  if (!Number.isInteger(n)) {
    return undefined;
  }
  return n;
}

const MINUTE_CONFIG: FieldConfig = {
  allowed: makeNumericSet(0, 59),
  toNumber: stringToNumber,
};

const HOUR_CONFIG: FieldConfig = {
  allowed: makeNumericSet(0, 23),
  toNumber: stringToNumber,
};

const DAY_OF_MONTH_CONFIG: FieldConfig = {
  allowed: makeNumericSet(1, 31),
  toNumber: stringToNumber,
};

const MONTH_CONFIG: FieldConfig = {
  allowed: makeSetWithNames(1, 12, MONTH_NAMES),
  toNumber: (normalized) => {
    const named = MONTH_NAMES[normalized];
    if (named !== undefined) {
      return named;
    }
    return stringToNumber(normalized);
  },
};

const DAY_OF_WEEK_CONFIG: FieldConfig = {
  allowed: makeSetWithNames(0, 7, DAY_OF_WEEK_NAMES),
  toNumber: (normalized) => {
    const named = DAY_OF_WEEK_NAMES[normalized];
    if (named !== undefined) {
      return named;
    }
    return stringToNumber(normalized);
  },
};

function parseCronAnyValue(string: string): CronAny | null {
  return string === "*" ? { type: "any" } : null;
}

function parseCronSingleValue(
  string: string,
  config: FieldConfig,
): CronValue | null {
  const normalized = string.toLowerCase();
  if (!config.allowed.has(normalized)) {
    return null;
  }
  const value = config.toNumber(normalized);
  if (value === undefined) {
    return null;
  }
  return { type: "value", value };
}

function parseCronRangeValue(
  string: string,
  config: FieldConfig,
): CronRange | null {
  const parts = string.split("-");
  if (parts.length !== 2) {
    return null;
  }
  const [first, second] = parts;
  if (!first || !second) {
    return null;
  }
  const normalizedFirst = first.toLowerCase();
  const normalizedSecond = second.toLowerCase();
  if (
    !config.allowed.has(normalizedFirst) ||
    !config.allowed.has(normalizedSecond)
  ) {
    return null;
  }
  const from = config.toNumber(normalizedFirst);
  const to = config.toNumber(normalizedSecond);
  if (from === undefined || to === undefined) {
    return null;
  }
  if (from > to) {
    return null;
  }
  return { type: "range", from, to };
}

function parseCronListValue(
  string: string,
  config: FieldConfig,
): CronList | null {
  const parts = string.split(",");
  if (parts.length < 2) {
    return null;
  }
  const values: Array<CronValue | CronRange> = [];
  for (const part of parts) {
    const single = parseCronSingleValue(part, config);
    if (single !== null) {
      values.push(single);
      continue;
    }
    const range = parseCronRangeValue(part, config);
    if (range !== null) {
      values.push(range);
      continue;
    }
    return null;
  }
  return { type: "list", values };
}

function parseStepNumber(string: string): number | null {
  const number = stringToNumber(string);
  if (number === undefined) {
    return null;
  }
  if (number <= 0) {
    return null;
  }
  return number;
}

function parseCronFieldValue(
  string: string,
  config: FieldConfig,
): CronFieldValue | null {
  const slashParts = string.split("/");
  if (slashParts.length > 2) {
    return null;
  }

  if (slashParts.length === 2) {
    const [baseString, stepString] = slashParts;
    if (!baseString || !stepString) {
      return null;
    }
    const step = parseStepNumber(stepString);
    if (step === null) {
      return null;
    }
    const base =
      parseCronAnyValue(baseString) ??
      parseCronSingleValue(baseString, config) ??
      parseCronRangeValue(baseString, config);
    if (base === null) {
      return null;
    }
    return { type: "step", base, step };
  }

  return (
    parseCronAnyValue(string) ??
    parseCronSingleValue(string, config) ??
    parseCronRangeValue(string, config) ??
    parseCronListValue(string, config)
  );
}

export function parseCronExpression(string: string): ParseCronResult {
  if (string.trim() !== string) {
    return { success: false };
  }

  const parts = string.split(" ");
  if (parts.length !== 5) {
    return { success: false };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return { success: false };
  }

  const parsedMinute = parseCronFieldValue(minute, MINUTE_CONFIG);
  const parsedHour = parseCronFieldValue(hour, HOUR_CONFIG);
  const parsedDayOfMonth = parseCronFieldValue(dayOfMonth, DAY_OF_MONTH_CONFIG);
  const parsedMonth = parseCronFieldValue(month, MONTH_CONFIG);
  const parsedDayOfWeek = parseCronFieldValue(dayOfWeek, DAY_OF_WEEK_CONFIG);

  if (
    parsedMinute === null ||
    parsedHour === null ||
    parsedDayOfMonth === null ||
    parsedMonth === null ||
    parsedDayOfWeek === null
  ) {
    return { success: false };
  }

  return {
    success: true,
    data: {
      minute: parsedMinute,
      hour: parsedHour,
      dayOfMonth: parsedDayOfMonth,
      month: parsedMonth,
      dayOfWeek: parsedDayOfWeek,
    },
  };
}
