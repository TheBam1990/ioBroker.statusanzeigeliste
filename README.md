# ioBroker Statusanzeigeliste

German documentation is available here: [README.de.md](README.de.md).

Statusanzeigeliste creates a compact status message list from configurable ioBroker state comparisons. It is the successor-style rebuild of the older `meldungsliste` idea with a modern jsonConfig admin UI, analog comparisons, state-to-state comparisons and ready-to-use VIS/VIS-2 widgets.

![Rule concept](docs/images/rule-concept.svg)

## Features

- Watch any ioBroker state.
- Compare against a fixed value or against another ioBroker state.
- Supports `=`, `!=`, `>`, `>=`, `<`, `<=` and `contains`.
- Supports automatic type detection plus explicit `number`, `boolean` or `string` comparison.
- Works with digital states and analog values.
- Keeps the first activation timestamp while a message stays active.
- Optional start date prefix.
- Optional start time prefix.
- Outputs HTML, plain text and JSON.
- Includes VIS/VIS-2 widgets so no manual string widget needs to be built.

## Outputs

The adapter creates these states:

| State | Description |
| --- | --- |
| `statusanzeigeliste.0.Meldungen` | HTML list, compatible with the old message-list style. |
| `statusanzeigeliste.0.html` | HTML list for the included widget. |
| `statusanzeigeliste.0.text` | Plain text list with one message per line. |
| `statusanzeigeliste.0.json` | Structured JSON array with active messages and values. |
| `statusanzeigeliste.0.info.activeCount` | Number of active messages. |
| `statusanzeigeliste.0.info.lastUpdate` | Last rebuild time. |
| `statusanzeigeliste.0.info.lastError` | Last rule evaluation error. |

## Rule Model

Each rule evaluates one condition:

```text
source state  operator  fixed value
source state  operator  compare state
```

If the condition is true, the configured message text appears in the list. If the condition becomes false, the message is removed.

![Comparison modes](docs/images/comparison-modes.svg)

## Admin Settings

### General

| Option | Meaning |
| --- | --- |
| Enable status list | Enables or disables all rule evaluation. |
| Show start date before message | Prepends the date when the message first became active. A space is inserted after it. |
| Show start time before message | Prepends the time when the message first became active. A space is inserted after it. |
| Text if no message is active | Optional text shown when the list is empty. |
| CSS class for message rows | CSS class used for generated HTML rows. Default: `statusanzeigeliste-row`. |

If both date and time are enabled, the output looks like:

```text
10.07.2026 18:42:03 Battery voltage too low
```

### Rules

| Column | Meaning |
| --- | --- |
| Active | Enables or disables this rule. |
| Name | Internal rule name for diagnostics. |
| Source state | ioBroker state to watch. |
| Compare | Operator: `=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`. |
| With | Choose fixed value or another ioBroker state. |
| Fixed value | Value used when `With = Fixed value`. |
| Compare state | State used when `With = Other state`. |
| Type | `auto`, `number`, `boolean` or `string`. |
| Severity | `info`, `warning`, `error` or `ok`; used as CSS class in the widget. |
| Message text | Text shown while the rule is active. |

## Comparison Examples

### Boolean Status

| Field | Value |
| --- | --- |
| Source state | `0_userdata.0.door.open` |
| Compare | `=` |
| With | Fixed value |
| Fixed value | `true` |
| Type | `boolean` |
| Message text | `Door is open` |

### Analog Limit

| Field | Value |
| --- | --- |
| Source state | `modbus.0.battery.voltage` |
| Compare | `<` |
| With | Fixed value |
| Fixed value | `48` |
| Type | `number` |
| Message text | `Battery voltage below 48 V` |

### Compare Two Analog States

| Field | Value |
| --- | --- |
| Source state | `0_userdata.0.house.load` |
| Compare | `>` |
| With | Other state |
| Compare state | `0_userdata.0.pv.production` |
| Type | `number` |
| Message text | `House load is higher than PV production` |

![VIS widget](docs/images/vis-widget.svg)

## VIS and VIS-2 Widget

The adapter ships with a widget set named `statusanzeigeliste`.

The default widget reads the plain text output state:

```text
statusanzeigeliste.0.text
```

In VIS/VIS-2 you can add the widget and optionally change:

| Widget option | Meaning |
| --- | --- |
| `oid` | State to display. Default: `statusanzeigeliste.0.text`. Plain text is rendered line by line; HTML states such as `statusanzeigeliste.0.html` are inserted as HTML. |
| `title` | Widget title. |
| `showTitle` | Shows or hides the title row. |
| `emptyText` | Fallback text if the selected state is empty. |

The widget uses CSS classes per message severity:

```css
.statusanzeigeliste-row.info
.statusanzeigeliste-row.warning
.statusanzeigeliste-row.error
.statusanzeigeliste-row.ok
```

You can override these classes in VIS if you need a project-specific design.

## Notes

- The first activation time is kept until the message disappears. If the same condition becomes active again later, a new start time is stored.
- Numeric comparison accepts decimal commas and decimal points.
- `auto` type uses number comparison if both values are numeric, boolean comparison if both values look boolean, otherwise string comparison.
- `contains` always compares as text.

## Changelog

### 0.1.0

- Initial Statusanzeigeliste adapter with configurable comparisons and VIS/VIS-2 widgets.

### 0.1.1

- Fix VIS widget state binding so the list value is displayed and updated.

### 0.1.2

- Update already registered VIS-2 widget templates during adapter startup.

### 0.1.3

- Make the VIS widget read `statusanzeigeliste.0.text` by default.
- Render plain text output line by line in the widget.

## License

MIT

Copyright (c) 2026 TheBam1990
