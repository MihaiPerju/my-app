import type { Equal, Expect } from "../types/assertions";
import type {
  CronAny,
  CronData,
  CronFieldValue,
  CronList,
  CronRange,
  CronStep,
  CronUnit,
  CronValue,
  ParseCronResult,
  parseCronExpression,
} from "./cron";

// ============================================================================
// parseCronExpression return type
// ============================================================================

// parseCronExpression should return ParseCronResult
type _testReturnType = Expect<
  Equal<ReturnType<typeof parseCronExpression>, ParseCronResult>
>;

// ============================================================================
// ParseCronResult discriminated union
// ============================================================================

// success branch carries CronData
type _testSuccessData = Expect<
  Equal<Extract<ParseCronResult, { success: true }>["data"], CronData>
>;

// CronData maps CronUnit keys to CronFieldValue
type _testCronData = Expect<Equal<CronData, Record<CronUnit, CronFieldValue>>>;

// ============================================================================
// CronFieldValue union members
// ============================================================================

type _testCronAnyMember = Expect<
  Equal<CronAny extends CronFieldValue ? true : false, true>
>;
type _testCronValueMember = Expect<
  Equal<CronValue extends CronFieldValue ? true : false, true>
>;
type _testCronRangeMember = Expect<
  Equal<CronRange extends CronFieldValue ? true : false, true>
>;
type _testCronListMember = Expect<
  Equal<CronList extends CronFieldValue ? true : false, true>
>;
type _testCronStepMember = Expect<
  Equal<CronStep extends CronFieldValue ? true : false, true>
>;
