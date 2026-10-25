import assert from "node:assert/strict";
import test from "node:test";
import {
  BENEFITS_EXPORT_HEADERS,
  FEEDBACK_EXPORT_HEADERS,
  IDEAS_EXPORT_HEADERS,
  exportCsvResponse,
} from "./export";

test("admin analytics exports expose dedicated ideas, benefits, and feedback CSV contracts", async () => {
  const cases = [
    { filename: "admin-ideas.csv", headers: IDEAS_EXPORT_HEADERS },
    { filename: "admin-benefits.csv", headers: BENEFITS_EXPORT_HEADERS },
    { filename: "admin-feedback.csv", headers: FEEDBACK_EXPORT_HEADERS },
  ] as const;

  for (const item of cases) {
    const response = exportCsvResponse({
      filename: item.filename,
      headers: item.headers,
      rows: [["=formula", "quoted, value", null]],
      requestId: "request-export-test",
      nextAfter: 42,
    });

    assert.equal(
      response.headers.get("content-type"),
      "text/csv; charset=utf-8",
    );
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="${item.filename}"`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-request-id"), "request-export-test");
    assert.equal(response.headers.get("x-next-after"), "42");
    const csv = await response.text();
    assert.match(csv, new RegExp(`^${item.headers.join(",")}\\r\\n`));
    assert.match(csv, /'=formula/);
    assert.match(csv, /"quoted, value"/);
  }
});

test("admin analytics export response omits pagination header at the end of the dataset", () => {
  const response = exportCsvResponse({
    filename: "admin-benefits.csv",
    headers: BENEFITS_EXPORT_HEADERS,
    rows: [],
    requestId: "request-export-last",
  });

  assert.equal(response.headers.get("x-next-after"), null);
});

