interface Widget {
  id: string;
}

type WidgetDictionary = Record<string, string>;

function named(input: Widget): void {}

function structural(config: { id: string }): void {}

function aliasedDictionary(entries: WidgetDictionary): void {}

function primitive(value: string): void {}
