import { useCallback, useState } from "react";

export interface ControllableStateOptions<T> {
  /** Controlled value. Pass `undefined` to let the component own the state. */
  value?: T;
  /** Initial value while uncontrolled. Ignored once `value` is provided. */
  defaultValue: T;
  /** Called with the next value on every change, controlled or not. */
  onChange?: (next: T) => void;
}

/**
 * State that a caller may control, or leave to the component. Returns the
 * current value and a setter that updates internal state only while
 * uncontrolled, and always notifies `onChange`.
 */
export function useControllableState<T>({
  defaultValue,
  onChange,
  value,
}: ControllableStateOptions<T>): [T, (next: T) => void] {
  const [internal, setInternal] = useState(defaultValue);
  const isControlled = value !== undefined;

  const set = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  return [isControlled ? value : internal, set];
}
