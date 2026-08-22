import assert from "node:assert/strict";
import test from "node:test";

import {
  getAllowedSubmissionChannelCodes,
  parseReimbursementAccessAccounts,
} from "./reimbursement-access.js";

test("parseReimbursementAccessAccounts supports partners and multi-store managers", () => {
  const result = parseReimbursementAccessAccounts(JSON.stringify([
    {
      accountId: "partner-001",
      username: "partner",
      password: "partner-password",
      role: "partner",
    },
    {
      accountId: "manager-001",
      username: "manager",
      password: "manager-password",
      role: "manager",
      managerStores: ["fuzzyqz", "fuzzy", "fuzzy"],
    },
  ]));

  assert.equal(result.error, undefined);
  assert.deepEqual(result.accounts[1]?.managerStores, ["fuzzy", "fuzzyqz"]);
  assert.deepEqual(getAllowedSubmissionChannelCodes({
    accountId: "manager-001",
    username: "manager",
    role: "manager",
    managerStores: result.accounts[1]?.managerStores ?? [],
  }), ["reimbursement_fuzzy_manager", "reimbursement_fuzzy_qz_manager"]);
});

test("submission channel permissions are role scoped", () => {
  assert.deepEqual(getAllowedSubmissionChannelCodes({
    accountId: "partner-001",
    username: "partner",
    role: "partner",
    managerStores: [],
  }), ["reimbursement_fuzzy", "reimbursement_peanut", "reimbursement_fuzzyqz"]);
  assert.equal(getAllowedSubmissionChannelCodes({
    accountId: "reimbursement-admin",
    username: "admin",
    role: "admin",
    managerStores: [],
  }).length, 6);
});

test("account parsing rejects invalid roles, stores, and duplicate identities", () => {
  assert.match(
    parseReimbursementAccessAccounts(JSON.stringify([{
      accountId: "manager-001",
      username: "manager",
      password: "password",
      role: "manager",
      managerStores: [],
    }])).error ?? "",
    /requires at least one manager store/,
  );
  assert.match(
    parseReimbursementAccessAccounts(JSON.stringify([
      {
        accountId: "partner-001",
        username: "same",
        password: "password",
        role: "partner",
      },
      {
        accountId: "manager-001",
        username: "same",
        password: "password",
        role: "manager",
        managerStores: ["fuzzy"],
      },
    ])).error ?? "",
    /Duplicate reimbursement username/,
  );
});
