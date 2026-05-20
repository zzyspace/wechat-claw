export type ScenarioCode = "loss-report";

export interface ChannelMatch {
  type: "room_topic";
  value: string;
}

export interface DeliveryTarget {
  type: "contact_name" | "room_topic";
  value: string;
}

export interface ChannelConfig {
  code: string;
  enabled: boolean;
  scenario: ScenarioCode;
  match: ChannelMatch;
  deliveryTargets: DeliveryTarget[];
  summarySchedule: string;
  weeklySummarySchedule?: string;
}
