import { test, expect } from "@playwright/test";
import { migrationFiles, migrationSql, query } from "../../support/versions";

// The account-deletion migration must be safe to run under the Worker that is
// already deployed: it only adds columns that are nullable or defaulted, never
// renames, drops or rewrites, so the previous Worker keeps running on the
// migrated database.

const file = () => migrationFiles().filter((f) => /_account_deletion\.sql$/.test(f));

test("one migration, numbered after every other, that only adds defaulted or nullable columns", () => {
  expect(file()).toHaveLength(1);
  const name = file()[0]!;
  const number = Number(name.slice(0, 4));
  const others = migrationFiles().filter((f) => f !== name).map((f) => Number(f.slice(0, 4)));
  expect(others).not.toContain(number);

  const code = migrationSql(name).replace(/--.*$/gm, "");
  expect(code).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|INSERT)\b/i);
  const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
  expect(statements.length).toBeGreaterThan(0);
  for (const stmt of statements) {
    expect(stmt, stmt).toMatch(/^(ALTER\s+TABLE\s+users\s+ADD\s+COLUMN\s+\w+\s+\w+(\s+NOT\s+NULL\s+DEFAULT\s+'[^']*')?|CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+.*)$/is);
    if (/NOT\s+NULL/i.test(stmt)) expect(stmt).toMatch(/DEFAULT/i);
  }
});

test("the columns exist, with the default that keeps every existing account active", async () => {
  const cols = await query<{ name: string; notnull: number; dflt_value: string | null }>(`SELECT name, "notnull", dflt_value FROM pragma_table_info('users')`);
  expect(cols.find((c) => c.name === "status")).toMatchObject({ notnull: 1, dflt_value: "'active'" });
  expect(cols.find((c) => c.name === "deleted_at")).toMatchObject({ notnull: 0 });
});
