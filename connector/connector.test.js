/**
 * The one decision in this file that can print nothing and report success:
 * which Windows print queue, if any, the receipts go to.
 *
 * A queue whose port has no printer behind it swallows every job silently, so
 * these cases are the difference between paper and a blank roll. No hardware:
 * the rows are what the PowerShell lookup hands back.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chooseUsbQueue } = require("./connector.js");

const LIVE = (port) => ["LIVE", port];
const QUEUE = (name, port, offline = "False") => ["QUEUE", name, port, offline];

test("takes the queue sitting on the live port", () => {
  const rows = [LIVE("USB002"), QUEUE("POS-58-Series (1)", "USB002")];
  assert.equal(chooseUsbQueue(rows), "POS-58-Series (1)");
});

test("refuses a queue wired to a port the printer is not on", () => {
  // The real bug: the vendor installer put the queue on its own monitor, the
  // cable came up as USB002, and Windows drained every receipt into nothing.
  const rows = [LIVE("USB002"), QUEUE("POS-58-Series (1)", "Printer PORT:")];
  const said = [];
  assert.equal(chooseUsbQueue(rows, null, (m) => said.push(m)), null);
  assert.match(said.join(" "), /Printer PORT:.*USB002.*Set-Printer/s);
});

test("refuses a queue left on a port number the replug moved away from", () => {
  const rows = [LIVE("USB003"), QUEUE("POS-58-Series (1)", "USB002")];
  assert.equal(chooseUsbQueue(rows), null);
});

test("no cable means no USB route", () => {
  assert.equal(chooseUsbQueue([QUEUE("POS-58-Series (1)", "USB002")]), null);
});

test("prefers the receipt printer over the laser on the same port", () => {
  const rows = [LIVE("USB002"), QUEUE("Canon LBP6030", "USB002"), QUEUE("POS-58 Thermal", "USB002")];
  assert.equal(chooseUsbQueue(rows), "POS-58 Thermal");
});

test("takes a lone unrecognisable queue rather than giving up", () => {
  const rows = [LIVE("USB002"), QUEUE("Some Printer", "USB002")];
  assert.equal(chooseUsbQueue(rows), "Some Printer");
});

test("will not guess between two equally plausible queues", () => {
  const rows = [LIVE("USB002"), QUEUE("POS-58 A", "USB002"), QUEUE("POS-58 B", "USB002")];
  const said = [];
  assert.equal(chooseUsbQueue(rows, null, (m) => said.push(m)), null);
  assert.match(said.join(" "), /PRINTER_NAME/);
});

test("ignores a queue Windows has marked offline", () => {
  const rows = [LIVE("USB002"), QUEUE("POS-58-Series (1)", "USB002", "True")];
  assert.equal(chooseUsbQueue(rows), null);
});

test("PRINTER_NAME wins, but still only on the live port", () => {
  const live = [LIVE("USB002"), QUEUE("POS-58 A", "USB002"), QUEUE("POS-58 B", "USB002")];
  assert.equal(chooseUsbQueue(live, "POS-58 B"), "POS-58 B");

  const wrong = [LIVE("USB002"), QUEUE("POS-58 B", "Printer PORT:")];
  assert.equal(chooseUsbQueue(wrong, "POS-58 B"), null);
});
