import assert from "node:assert/strict";
import test from "node:test";
import { actionChannels, validateExpenseAuthorization, reportAccessScope, canViewResource, canDeleteReport, hasPermission, submissionChannels } from "./authorization.js";
import type { AdminSession } from "./auth.js";
import { gatewayAuthConfig } from "./gateway-auth.js";

const envelope = {
  success: true,
  account: { accountId: "person", username: "person", enabled: true, version: 1 },
  access: { accountId: "person", app: "expense", role: "admin", enabled: true, version: 1,
    permissions: ["report:view", "report:submit"], config: {
      viewScope: { ownership: "self", stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
      submitScope: { stores: ["peanut"], channels: ["reimbursement_peanut_manager"] },
    } },
};

test("expense viewing and submission scopes are independent of role", () => {
  const session = validateExpenseAuthorization(envelope);
  assert.equal(hasPermission(session, "report:delete"), false);
  assert.equal(hasPermission(session, "report:edit"), false);
  assert.equal(hasPermission(session, "task:view:any"), false);
  assert.deepEqual(submissionChannels(session), ["reimbursement_peanut_manager"]);
  assert.deepEqual(reportAccessScope(session), { submittedByAccountId: "person", allowedChannelCodes: ["reimbursement_fuzzy_manager"] });
  assert.ok(canViewResource(session, { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy_manager" }));
  for (const resource of [
    { submittedByAccountId: "other", channelCode: "reimbursement_fuzzy_manager" },
    { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy" },
    { submittedByAccountId: "person", channelCode: "reimbursement_peanut_manager" },
    { channelCode: "reimbursement_fuzzy_manager" },
  ]) assert.equal(canViewResource(session, resource), false);
});

test("unknown expense permissions and incomplete scopes fail closed", () => {
  for (const access of [
    { ...envelope.access, permissions: ["other:admin"] },
    { ...envelope.access, app: "invoice" },
    { ...envelope.access, config: {} },
    { ...envelope.access, config: { ...envelope.access.config, override: true } },
    { ...envelope.access, config: { ...envelope.access.config, viewScope: { ownership: "self", stores: ["unknown"], channels: "all" } } },
    { ...envelope.access, enabled: false },
    { ...envelope.access, permissions: ["report:delete"], config: envelope.access.config },
    { ...envelope.access, permissions: ["report:delete:self"], config: envelope.access.config },
    { ...envelope.access, permissions: ["report:submit", "report:delete:self"], config: envelope.access.config },
    { ...envelope.access, permissions: ["report:view"], config: { ...envelope.access.config, viewScope: { ownership: "self", stores: [], channels: [] } } },
  ]) assert.throws(() => validateExpenseAuthorization({ ...envelope, access }));
});

test("self deletion uses account ownership independently of role and upload source", () => {
  for (const role of ["admin", "partner", "manager"]) {
    const session = validateExpenseAuthorization({
      ...envelope,
      access: {
        ...envelope.access,
        role,
        permissions: ["report:view", "report:delete:self"],
        config: {
          ...envelope.access.config,
          viewScope: { ownership: "any", stores: "all", channels: "all" },
        },
      },
    });
    assert.equal(session.canWrite, true);
    assert.equal(session.canViewAllReports, true);
    assert.equal(hasPermission(session, "report:delete"), false);
    assert.equal(hasPermission(session, "report:edit"), false);
    assert.equal(hasPermission(session, "report:import"), false);
    for (const source of ["batch_import", "manual_import", "shortcut_api"]) {
      const ownReport = { source, submittedByAccountId: "person", channelCode: "reimbursement_fuzzy_manager", reporter: "someone else" };
      assert.equal(canDeleteReport(session, ownReport), true);
    }
    for (const resource of [
      { submittedByAccountId: "other", channelCode: "reimbursement_fuzzy_manager", reporter: "person", submittedByUsername: "person" },
      { channelCode: "reimbursement_fuzzy_manager", reporter: "person", submittedByUsername: "person" },
      { submittedByAccountId: "", channelCode: "reimbursement_fuzzy_manager" },
    ]) {
      assert.equal(canViewResource(session, resource), true);
      assert.equal(canDeleteReport(session, resource), false);
    }
    assert.equal(canDeleteReport(undefined, { submittedByAccountId: "person" }), false);
    assert.equal(canDeleteReport({
      ...session,
      authorization: { ...session.authorization!, permissions: ["report:delete:self"] },
    }, { submittedByAccountId: "person" }), false);
  }
});

test("both deletion permissions respect the viewing store channel and ownership scopes", () => {
  for (const permission of ["report:delete", "report:delete:self"]) {
    const session = validateExpenseAuthorization({
      ...envelope,
      access: { ...envelope.access, permissions: ["report:view", permission] },
    });
    assert.equal(canDeleteReport(session, { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy_manager" }), true);
    for (const resource of [
      { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy" },
      { submittedByAccountId: "person", channelCode: "reimbursement_peanut_manager" },
      { submittedByAccountId: "other", channelCode: "reimbursement_fuzzy_manager" },
      { submittedByAccountId: "person" },
    ]) assert.equal(canDeleteReport(session, resource), false);
  }
  const viewOnly = validateExpenseAuthorization(envelope);
  assert.equal(canDeleteReport(viewOnly, { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy_manager" }), false);
});

test("full deletion still permits visible records owned by others or without an owner", () => {
  const session = validateExpenseAuthorization({
    ...envelope,
    access: {
      ...envelope.access,
      permissions: ["report:view", "report:delete"],
      config: {
        ...envelope.access.config,
        viewScope: { ownership: "any", stores: ["fuzzy"], channels: "all" },
      },
    },
  });
  for (const submittedByAccountId of ["person", "other", undefined]) {
    assert.equal(canDeleteReport(session, { submittedByAccountId, channelCode: "reimbursement_fuzzy" }), true);
    assert.equal(canDeleteReport(session, { submittedByAccountId, channelCode: "reimbursement_peanut" }), false);
  }
});

test("legacy administrators retain deletion and other legacy roles gain no deletion", () => {
  const session: AdminSession = {
    accountId: "person", username: "person", role: "admin", managerStores: ["fuzzy"],
    canWrite: true, canSubmit: true, canViewAllReports: true,
  };
  for (const resource of [
    { submittedByAccountId: "person", channelCode: "reimbursement_fuzzy_manager" },
    { submittedByAccountId: "other", channelCode: "reimbursement_fuzzy_manager" },
    {},
  ]) {
    assert.equal(canDeleteReport(session, resource), true);
    assert.equal(canDeleteReport({ ...session, role: "manager" }, resource), false);
    assert.equal(canDeleteReport({ ...session, role: "partner" }, resource), false);
  }
});

test("import and submission use independent scopes with legacy fallback", () => {
  const access = {
    ...envelope.access,
    permissions: ["report:view", "report:submit", "report:import"],
    config: {
      ...envelope.access.config,
      importScope: { stores: ["fuzzyqz"], channels: ["reimbursement_fuzzyqz"] },
    },
  };
  const session = validateExpenseAuthorization({ ...envelope, access });
  assert.deepEqual(submissionChannels(session), ["reimbursement_peanut_manager"]);
  assert.deepEqual(actionChannels(session, "report:import"), ["reimbursement_fuzzyqz"]);
  const legacy = validateExpenseAuthorization({ ...envelope, access: { ...access, config: envelope.access.config } });
  assert.deepEqual(actionChannels(legacy, "report:import"), ["reimbursement_peanut_manager"]);
});

test("expense transport rejects unknown modes and non-loopback URLs", () => {
  assert.throws(() => gatewayAuthConfig({ ADMIN_AUTH_MODE: "unifed" }));
  assert.throws(() => gatewayAuthConfig({ ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: "fixture-secret-000000000000000000001", ADMIN_AUTH_GATEWAY_URL: "http://example.test" }));
});
