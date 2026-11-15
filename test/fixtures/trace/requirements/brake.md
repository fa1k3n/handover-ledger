# Requirements of the example

A made-up brake controller, for the tests of `howl trace`.

## Words

| Term | Meaning |
|---|---|
| REQ-BRK-999 | Not a requirement: this table has no ID heading. |

## Control

| ID          | Requirement                                               | Ver | Status      |
|-------------|-----------------------------------------------------------|:---:|-------------|
| REQ-BRK-010 | A released pedal asks for no pressure.                    | T   | Implemented |
| REQ-BRK-011 | A fully pressed pedal asks for the largest pressure.      | T   | Implemented |
| REQ-BRK-012 | The demanded pressure rises at most 2.5 bar in one cycle. | T   | Verified    |
| REQ-BRK-013 | A fall of the demanded pressure is passed on at once.     | T   | Implemented |
| REQ-BRK-014 | A demand of a \| b is one cell.                           | T   | Draft       |
| see below   | A row whose first cell is no ID is passed over.           |     |             |

An example of the form, not a table of requirements:

```
| ID          | Requirement               | Ver | Status      |
|-------------|---------------------------|-----|-------------|
| REQ-BRK-777 | Inside a block of code.   | T   | Implemented |
```

## Safety

| ID | Requirement | Ver | Status |
|---|---|---|---|
| REQ-BRK-020 | Two pedal sensors that agree give the larger of their readings. | T | Implemented |
| REQ-BRK-021 | The wiring diagram names every sensor. | I | Implemented |
| REQ-BRK-010 | Given a second time. | T | Draft |
