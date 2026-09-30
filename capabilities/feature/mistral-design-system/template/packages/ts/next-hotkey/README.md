# `@mistral/next-hotkey`

## Usage

```tsx
import { useHotkey } from "@mistral/next-hotkey";

export const MyComponent = () => {
  useHotkey("ctrl+k", () => {
    alert("ctrl+k pressed");
  });
  return null;
};
```

## API

### useHotkey(key, callback, options)

```typescript
useHotkey(key: string, callback: (event: KeyboardEvent, handler: HotkeysEvent) => void, options: Options = DEFAULT_OPTIONS)
```

| Parameter  | Type                                                    | Required? | Default value     | Description                                                                                                                                                                   |
| ---------- | ------------------------------------------------------- | --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`      | `string`                                                | required  | -                 | Set the hotkeys you want the hook to listen to. To separate multiple keys, use a plus sign. This split key value can be overridden with the `splitKey` option.                |
| `callback` | `(event: KeyboardEvent, handler: HotkeysEvent) => void` | required  | -                 | This is the callback function that will be called when the hotkey is pressed. The callback will receive the browsers native `KeyboardEvent` and the libraries `HotkeysEvent`. |
| `options`  | `Options`                                               | optional  | `DEFAULT_OPTIONS` | Object to modify the behavior of the hook. Default options are given below.                                                                                                   |

Use `KeyboardEvent.code` values such as `digit1` when the shortcut should
target a physical key independently of keyboard layout.

### Options

All options are optional and have a default value which you can override to change the behavior of the hook.

| Option           | Type                                                                                 | Default value | Description                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`        | `boolean`                                                                            | `false`       | Set this to `true` if you want the hook to listen to the `keydown` event in the capture phase.                                                                                                                                   |
| `isDisabled`     | `boolean`                                                                            | `false`       | When `true`, the hook does not register any event listeners. The hotkey callback will not be called.                                                                                                                             |
| `preventDefault` | `boolean` or `(keyboardEvent: KeyboardEvent, hotkeysEvent: HotkeysEvent) => boolean` | `false`       | Set this to a `true` if you want the hook to prevent the browsers default behavior on certain keystrokes like `meta+s` to save a page. Note that certain keystrokes are not preventable, like `meta+w` to close a tab in Chrome. |
| `splitKey`       | `string`                                                                             | `+`           | Character to separate different keystrokes like `ctrl+a`, `ctrl+b`, etc.                                                                                                                                                         |
