export interface ReimbursementExpenseCategoryDefinition {
  aliases: string[];
  code: string;
  label: string;
}

export const DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY = "other";

export const REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS: ReimbursementExpenseCategoryDefinition[] = [
  {
    aliases: ["food", "食材"],
    code: "food",
    label: "食材",
  },
  {
    aliases: ["electricity", "电费"],
    code: "electricity",
    label: "电费",
  },
  {
    aliases: ["other", "其他"],
    code: "other",
    label: "其他",
  },
];

export function findReimbursementExpenseCategoryDefinition(code: string) {
  return REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS.find((definition) => definition.code === code) ?? null;
}

export function getReimbursementExpenseCategoryLabel(code: string) {
  return findReimbursementExpenseCategoryDefinition(code)?.label ?? code;
}

export function normalizeReimbursementExpenseCategory(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  return (
    REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS.find((definition) =>
      definition.aliases.some((alias) => alias.toLowerCase() === normalized),
    )?.code ?? null
  );
}

export function resolveReimbursementExpenseCategory(value: string | null | undefined, fallback: string) {
  return normalizeReimbursementExpenseCategory(value) ?? fallback;
}

export function mergeReimbursementExpenseCategory(existing: string, incoming: string) {
  if (existing === incoming) {
    return existing;
  }

  if (incoming === DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY) {
    return existing;
  }

  if (existing === DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY) {
    return incoming;
  }

  return incoming;
}
