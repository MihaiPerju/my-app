import type { ReactNode } from "react";

export type SelectOption<TValue extends string = string> = {
  value: TValue;
  label: string;
};

type FieldProps = {
  /**
   * The `id` of the control this field labels. Drives both `<label for>` and the id of the
   * description element, so the two can never drift apart.
   */
  htmlFor: string;
  label: string;
  description?: string;
  children: ReactNode;
};

type TextInputProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  required?: boolean;
  type?: "text" | "url" | "number" | "password";
};

type TextAreaInputProps = Omit<TextInputProps, "type"> & {
  rows?: number;
};

type SelectInputProps<TValue extends string> = {
  id: string;
  label: string;
  value: TValue;
  options: readonly SelectOption<TValue>[];
  onChange: (value: TValue) => void;
  description?: string;
};

type CheckboxInputProps = {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  description?: string;
};

type FileInputProps = {
  id: string;
  label: string;
  onFile: (file: File | null) => void;
  accept?: string;
  description?: string;
  required?: boolean;
  fileName?: string;
};

export const inputClassName =
  "border-default bg-input text-default placeholder:text-placeholder shadow-card w-full rounded-card-sm border px-3 py-2 text-sm outline-none transition focus:border-input-highlight focus:shadow-input-focus";

/**
 * The id of the element carrying a field's help text, or `undefined` when the field has none.
 *
 * Help text sits outside the `<label>` because it is guidance, not the accessible name, so a
 * screen reader announces it only through an explicit `aria-describedby` from the control. Every
 * control below derives both ends of that link from this function.
 */
function descriptionIdFor(id: string, description?: string): string | undefined {
  return description ? `${id}-description` : undefined;
}

export function Field({ htmlFor, label, description, children }: FieldProps) {
  return (
    <div className="grid gap-2">
      <label className="grid gap-2" htmlFor={htmlFor}>
        <span className="text-default text-sm font-semibold">{label}</span>
        {children}
      </label>
      {description ? (
        <span id={descriptionIdFor(htmlFor, description)} className="text-muted text-xs leading-5">
          {description}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  description,
  required,
  type = "text",
}: TextInputProps) {
  return (
    <Field htmlFor={id} label={label} description={description}>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        aria-describedby={descriptionIdFor(id, description)}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={inputClassName}
      />
    </Field>
  );
}

export function TextAreaInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  description,
  required,
  rows = 4,
}: TextAreaInputProps) {
  return (
    <Field htmlFor={id} label={label} description={description}>
      <textarea
        id={id}
        value={value}
        required={required}
        rows={rows}
        placeholder={placeholder}
        aria-describedby={descriptionIdFor(id, description)}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={`${inputClassName} resize-y leading-6`}
      />
    </Field>
  );
}

export function SelectInput<TValue extends string>({
  id,
  label,
  value,
  options,
  onChange,
  description,
}: SelectInputProps<TValue>) {
  return (
    <Field htmlFor={id} label={label} description={description}>
      <select
        id={id}
        value={value}
        aria-describedby={descriptionIdFor(id, description)}
        onChange={(event) => {
          const selected = options.find((option) => option.value === event.currentTarget.value);
          if (selected) {
            onChange(selected.value);
          }
        }}
        className={inputClassName}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function FileInput({
  id,
  label,
  onFile,
  accept,
  description,
  required,
  fileName,
}: FileInputProps) {
  return (
    <Field htmlFor={id} label={label} description={description}>
      <input
        id={id}
        type="file"
        accept={accept}
        required={required}
        aria-describedby={descriptionIdFor(id, description)}
        onChange={(event) => onFile(event.currentTarget.files?.[0] ?? null)}
        className={`${inputClassName} file:text-default file:border-default file:bg-card-subtle file:mr-3 file:cursor-pointer file:rounded-card-sm file:border file:px-3 file:py-1 file:text-sm file:font-medium`}
      />
      {fileName ? <span className="text-muted text-xs leading-5">Selected: {fileName}</span> : null}
    </Field>
  );
}

export function CheckboxInput({ id, label, checked, onChange, description }: CheckboxInputProps) {
  const descriptionId = descriptionIdFor(id, description);

  // The description is a sibling of the `<label>`, not a child of it: nested inside, it would be
  // concatenated into the checkbox's accessible *name* instead of announced as its description.
  // `ml-7` (checkbox `size-4` + `gap-3`) keeps it visually aligned under the label text.
  return (
    <div className="border-default bg-card-subtle grid gap-1 rounded-card-sm border p-3">
      <label className="flex items-start gap-3" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={descriptionId}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className="border-default bg-input mt-0.5 size-4 rounded-sm"
        />
        <span className="text-default text-sm font-semibold">{label}</span>
      </label>
      {description ? (
        <span id={descriptionId} className="text-muted ml-7 text-xs leading-5">
          {description}
        </span>
      ) : null}
    </div>
  );
}
