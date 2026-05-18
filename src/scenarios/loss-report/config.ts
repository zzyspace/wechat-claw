export interface LossReportScenarioConfig {
  summaryCron: string;
  summaryPromptTemplate: string;
  mergeWindowSeconds: number;
}

export function getLossReportScenarioConfig(input: {
  summaryCron: string;
  summaryPromptTemplate: string;
  mergeWindowSeconds: number;
}): LossReportScenarioConfig {
  return {
    summaryCron: input.summaryCron,
    summaryPromptTemplate: input.summaryPromptTemplate,
    mergeWindowSeconds: input.mergeWindowSeconds,
  };
}
