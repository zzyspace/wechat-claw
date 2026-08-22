export type ReimbursementAccountRole = "admin" | "partner" | "manager";

export const REIMBURSEMENT_MANAGER_STORES = ["fuzzy", "peanut", "fuzzyqz"] as const;
export type ReimbursementManagerStore = (typeof REIMBURSEMENT_MANAGER_STORES)[number];

export interface ReimbursementAccessAccountConfig {
  accountId: string;
  managerStores: ReimbursementManagerStore[];
  password: string;
  role: Exclude<ReimbursementAccountRole, "admin">;
  username: string;
}

export interface ReimbursementAccessPrincipal {
  accountId: string;
  managerStores: ReimbursementManagerStore[];
  role: ReimbursementAccountRole;
  username: string;
}

export interface ReimbursementAccountParseResult {
  accounts: ReimbursementAccessAccountConfig[];
  error?: string;
}

function trimmed(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseReimbursementAccessAccounts(value: string | undefined): ReimbursementAccountParseResult {
  const raw = value?.trim();
  if (!raw) return { accounts: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      accounts: [],
      error: `WECHATY_REIMBURSEMENT_ACCOUNTS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { accounts: [], error: "WECHATY_REIMBURSEMENT_ACCOUNTS_JSON must be a JSON array." };
  }

  const accounts: ReimbursementAccessAccountConfig[] = [];
  const accountIds = new Set<string>();
  const usernames = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { accounts: [], error: `Reimbursement account ${index + 1} must be an object.` };
    }
    const record = item as Record<string, unknown>;
    const accountId = trimmed(record.accountId);
    const username = trimmed(record.username);
    const password = trimmed(record.password);
    const role = trimmed(record.role);
    if (!accountId || !username || !password || !role) {
      return {
        accounts: [],
        error: `Reimbursement account ${index + 1} requires accountId, username, password, and role.`,
      };
    }
    if (role !== "partner" && role !== "manager") {
      return { accounts: [], error: `Reimbursement account ${accountId} has unsupported role: ${role}.` };
    }
    if (accountIds.has(accountId)) {
      return { accounts: [], error: `Duplicate reimbursement accountId: ${accountId}.` };
    }
    if (usernames.has(username)) {
      return { accounts: [], error: `Duplicate reimbursement username: ${username}.` };
    }

    const rawStores = record.managerStores ?? [];
    if (!Array.isArray(rawStores)) {
      return { accounts: [], error: `Reimbursement account ${accountId} managerStores must be an array.` };
    }
    const stores = [...new Set(rawStores.map(trimmed))];
    if (stores.some((store) => !REIMBURSEMENT_MANAGER_STORES.includes(store as ReimbursementManagerStore))) {
      return { accounts: [], error: `Reimbursement account ${accountId} has an unsupported manager store.` };
    }
    if (role === "manager" && stores.length === 0) {
      return {
        accounts: [],
        error: `Reimbursement manager account ${accountId} requires at least one manager store.`,
      };
    }
    if (role === "partner" && stores.length > 0) {
      return {
        accounts: [],
        error: `Reimbursement partner account ${accountId} cannot configure managerStores.`,
      };
    }

    accountIds.add(accountId);
    usernames.add(username);
    accounts.push({
      accountId,
      username,
      password,
      role,
      managerStores: stores.sort() as ReimbursementManagerStore[],
    });
  }
  return { accounts };
}

export const PARTNER_REIMBURSEMENT_CHANNEL_CODES = [
  "reimbursement_fuzzy",
  "reimbursement_peanut",
  "reimbursement_fuzzyqz",
] as const;

export const MANAGER_REIMBURSEMENT_CHANNEL_BY_STORE: Record<ReimbursementManagerStore, string> = {
  fuzzy: "reimbursement_fuzzy_manager",
  peanut: "reimbursement_peanut_manager",
  fuzzyqz: "reimbursement_fuzzy_qz_manager",
};

export const REIMBURSEMENT_SUBMISSION_CHANNEL_LABELS = new Map<string, string>([
  ["reimbursement_fuzzy", "Fuzzy"],
  ["reimbursement_peanut", "Peanut"],
  ["reimbursement_fuzzyqz", "Fuzzy泉州店"],
  ["reimbursement_fuzzy_manager", "Fuzzy店长报账"],
  ["reimbursement_peanut_manager", "Peanut店长报账"],
  ["reimbursement_fuzzy_qz_manager", "Fuzzy泉州店长报账"],
]);

export function getAllowedSubmissionChannelCodes(principal: ReimbursementAccessPrincipal) {
  if (principal.role === "admin") {
    return [...REIMBURSEMENT_SUBMISSION_CHANNEL_LABELS.keys()];
  }
  if (principal.role === "partner") {
    return [...PARTNER_REIMBURSEMENT_CHANNEL_CODES];
  }
  return principal.managerStores.map((store) => MANAGER_REIMBURSEMENT_CHANNEL_BY_STORE[store]);
}
