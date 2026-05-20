import type { ChannelConfig, DeliveryTarget, ScenarioCode } from "./types.js";

export function getChannelDisplayName(channel: ChannelConfig): string {
  return channel.match.value;
}

export function getEnabledChannels(channels: ChannelConfig[]): ChannelConfig[] {
  return channels.filter((channel) => channel.enabled);
}

export function getEnabledScenarioChannels(
  channels: ChannelConfig[],
  scenario: ScenarioCode,
): ChannelConfig[] {
  return getEnabledChannels(channels).filter((channel) => channel.scenario === scenario);
}

export function matchChannelByRoomTopic(
  channels: ChannelConfig[],
  roomTopic: string,
): ChannelConfig | null {
  return (
    getEnabledChannels(channels).find(
      (channel) => channel.match.type === "room_topic" && channel.match.value === roomTopic,
    ) ?? null
  );
}

export function serializeDeliveryTarget(target: DeliveryTarget): string {
  return `${target.type}:${target.value}`;
}

export function dedupeDeliveryTargets(targets: DeliveryTarget[]): DeliveryTarget[] {
  const deduped: DeliveryTarget[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const key = serializeDeliveryTarget(target);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

export function collectChannelDeliveryTargets(channels: ChannelConfig[]): DeliveryTarget[] {
  return dedupeDeliveryTargets(getEnabledChannels(channels).flatMap((channel) => channel.deliveryTargets));
}
