import { expect, test } from "bun:test";

import {
  ALL_TASK_DISPLAY_FIELDS,
  parseTaskDisplayFields,
  serializeTaskDisplayFields,
} from "#src/features/settings/task-display-fields";

/**
 * Which of a Task's number, source, Project and owner the Tasks page shows is a per-device
 * choice. Stored as the fields hidden, so a field added later shows by default.
 */
test("nothing stored, or something unreadable, shows every field", () => {
  expect(parseTaskDisplayFields(null)).toEqual(ALL_TASK_DISPLAY_FIELDS);
  expect(parseTaskDisplayFields("not-a-field,,")).toEqual(ALL_TASK_DISPLAY_FIELDS);
});

test("hidden fields round-trip, and unknown names are ignored", () => {
  const fields = { ...ALL_TASK_DISPLAY_FIELDS, source: false, owner: false };
  const stored = serializeTaskDisplayFields(fields);
  expect(stored).toBe("source,owner");
  expect(parseTaskDisplayFields(`${stored},priority`)).toEqual(fields);
});
